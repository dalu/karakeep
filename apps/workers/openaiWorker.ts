import { Job, Worker } from "bullmq";
import { and, eq, inArray } from "drizzle-orm";
import OpenAI from "openai";
import { z } from "zod";

import { db } from "@hoarder/db";
import { bookmarks, bookmarkTags, tagsOnBookmarks } from "@hoarder/db/schema";
import serverConfig from "@hoarder/shared/config";
import logger from "@hoarder/shared/logger";
import { readAsset } from "@hoarder/shared/assetdb";
import {
  OpenAIQueue,
  queueConnectionDetails,
  SearchIndexingQueue,
  ZOpenAIRequest,
  zOpenAIRequestSchema,
} from "@hoarder/shared/queues";

const openAIResponseSchema = z.object({
  tags: z.array(z.string()),
});

async function attemptMarkTaggingStatus(
  jobData: object | undefined,
  status: "success" | "failure",
) {
  if (!jobData) {
    return;
  }
  try {
    const request = zOpenAIRequestSchema.parse(jobData);
    await db
      .update(bookmarks)
      .set({
        taggingStatus: status,
      })
      .where(eq(bookmarks.id, request.bookmarkId));
  } catch (e) {
    console.log(`Something went wrong when marking the tagging status: ${e}`);
  }
}

export class OpenAiWorker {
  static build() {
    logger.info("Starting openai worker ...");
    const worker = new Worker<ZOpenAIRequest, void>(
      OpenAIQueue.name,
      runOpenAI,
      {
        connection: queueConnectionDetails,
        autorun: false,
      },
    );

    worker.on("completed", async (job): Promise<void> => {
      const jobId = job?.id ?? "unknown";
      logger.info(`[openai][${jobId}] Completed successfully`);
      await attemptMarkTaggingStatus(job?.data, "success");
    });

    worker.on("failed", async (job, error): Promise<void> => {
      const jobId = job?.id ?? "unknown";
      logger.error(`[openai][${jobId}] openai job failed: ${error}`);
      await attemptMarkTaggingStatus(job?.data, "failure");
    });

    return worker;
  }
}

const IMAGE_PROMPT_BASE = `
I'm building a read-it-later app and I need your help with automatic tagging.
Please analyze the attached image and suggest relevant tags that describe its key themes, topics, and main ideas.
Aim for a variety of tags, including broad categories, specific keywords, and potential sub-genres. If it's a famous website
you may also include a tag for the website. If the tag is not generic enough, don't include it. Aim for 10-15 tags.
If there are no good tags, don't emit any. You must respond in valid JSON with the key "tags" and the value is list of tags.
Don't wrap the response in a markdown code.`;

const TEXT_PROMPT_BASE = `
I'm building a read-it-later app and I need your help with automatic tagging.
Please analyze the text after the sentence "CONTENT START HERE:" and suggest relevant tags that describe its key themes, topics, and main ideas.
Aim for a variety of tags, including broad categories, specific keywords, and potential sub-genres. If it's a famous website
you may also include a tag for the website. If the tag is not generic enough, don't include it. Aim for 3-5 tags. If there are no good tags, don't emit any.
The content can include text for cookie consent and privacy policy, ignore those while tagging.
You must respond in JSON with the key "tags" and the value is list of tags.
CONTENT START HERE:
`;

function buildPrompt(
  bookmark: NonNullable<Awaited<ReturnType<typeof fetchBookmark>>>,
) {
  if (bookmark.link) {
    if (!bookmark.link.description && !bookmark.link.content) {
      throw new Error(
        `No content found for link "${bookmark.id}". Skipping ...`,
      );
    }

    let content = bookmark.link.content;
    if (content) {
      let words = content.split(" ");
      if (words.length > 2000) {
        words = words.slice(2000);
        content = words.join(" ");
      }
    }
    return `
${TEXT_PROMPT_BASE}
URL: ${bookmark.link.url}
Title: ${bookmark.link.title ?? ""}
Description: ${bookmark.link.description ?? ""}
Content: ${content ?? ""}
  `;
  }

  if (bookmark.text) {
    // TODO: Ensure that the content doesn't exceed the context length of openai
    return `
${TEXT_PROMPT_BASE}
${bookmark.text.text}
  `;
  }

  throw new Error("Unknown bookmark type");
}

async function fetchBookmark(linkId: string) {
  return await db.query.bookmarks.findFirst({
    where: eq(bookmarks.id, linkId),
    with: {
      link: true,
      text: true,
      asset: true,
    },
  });
}

async function inferTagsFromImage(
  jobId: string,
  bookmark: NonNullable<Awaited<ReturnType<typeof fetchBookmark>>>,
  openai: OpenAI,
) {

  const { asset, metadata } = await readAsset({
    userId: bookmark.userId,
    assetId: bookmark.asset.assetId,
  });

  if (!asset) {
    throw new Error(`[openai][${jobId}] AssetId ${bookmark.asset.assetId} for bookmark ${bookmark.id} not found`);
  }
  const base64 = asset.toString('base64');

  const chatCompletion = await openai.chat.completions.create({
    model: serverConfig.inference.imageModel,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: IMAGE_PROMPT_BASE },
          {
            type: "image_url",
            image_url: {
              url: `data:${metadata.contentType};base64,${base64}`,
              detail: "low",
            },
          },
        ],
      },
    ],
    max_tokens: 2000,
  });

  const response = chatCompletion.choices[0].message.content;
  if (!response) {
    throw new Error(`[openai][${jobId}] Got no message content from OpenAI`);
  }
  return { response, totalTokens: chatCompletion.usage?.total_tokens };
}

async function inferTagsFromText(
  jobId: string,
  bookmark: NonNullable<Awaited<ReturnType<typeof fetchBookmark>>>,
  openai: OpenAI,
) {
  const chatCompletion = await openai.chat.completions.create({
    messages: [{ role: "system", content: buildPrompt(bookmark) }],
    model: serverConfig.inference.textModel,
    response_format: { type: "json_object" },
  });

  const response = chatCompletion.choices[0].message.content;
  if (!response) {
    throw new Error(`[openai][${jobId}] Got no message content from OpenAI`);
  }
  return { response, totalTokens: chatCompletion.usage?.total_tokens };
}

async function inferTags(
  jobId: string,
  bookmark: NonNullable<Awaited<ReturnType<typeof fetchBookmark>>>,
  openai: OpenAI,
) {
  let response;
  if (bookmark.link || bookmark.text) {
    response = await inferTagsFromText(jobId, bookmark, openai);
  } else if (bookmark.asset) {
    response = await inferTagsFromImage(jobId, bookmark, openai);
  } else {
    throw new Error(`[openai][${jobId}] Unsupported bookmark type`);
  }

  try {
    let tags = openAIResponseSchema.parse(JSON.parse(response.response)).tags;
    logger.info(
      `[openai][${jobId}] Inferring tag for bookmark "${bookmark.id}" used ${response.totalTokens} tokens and inferred: ${tags}`,
    );

    // Sometimes the tags contain the hashtag symbol, let's strip them out if they do.
    tags = tags.map((t) => {
      if (t.startsWith("#")) {
        return t.slice(1);
      }
      return t;
    });

    return tags;
  } catch (e) {
    throw new Error(
      `[openai][${jobId}] Failed to parse JSON response from OpenAI: ${e}`,
    );
  }
}

async function connectTags(
  bookmarkId: string,
  newTags: string[],
  userId: string,
) {
  if (newTags.length == 0) {
    return;
  }

  await db.transaction(async (tx) => {
    // Create tags that didn't exist previously
    await tx
      .insert(bookmarkTags)
      .values(
        newTags.map((t) => ({
          name: t,
          userId,
        })),
      )
      .onConflictDoNothing();

    const newTagIds = (
      await tx.query.bookmarkTags.findMany({
        where: and(
          eq(bookmarkTags.userId, userId),
          inArray(bookmarkTags.name, newTags),
        ),
        columns: {
          id: true,
        },
      })
    ).map((r) => r.id);

    // Delete old AI tags
    await tx
      .delete(tagsOnBookmarks)
      .where(
        and(
          eq(tagsOnBookmarks.attachedBy, "ai"),
          eq(tagsOnBookmarks.bookmarkId, bookmarkId),
        ),
      );

    // Attach new ones
    await tx
      .insert(tagsOnBookmarks)
      .values(
        newTagIds.map((tagId) => ({
          tagId,
          bookmarkId,
          attachedBy: "ai" as const,
        })),
      )
      .onConflictDoNothing();
  });
}

async function runOpenAI(job: Job<ZOpenAIRequest, void>) {
  const jobId = job.id ?? "unknown";

  const { inference } = serverConfig;

  if (!inference.openAIApiKey) {
    logger.debug(
      `[openai][${jobId}] OpenAI is not configured, nothing to do now`,
    );
    return;
  }

  const openai = new OpenAI({
    apiKey: inference.openAIApiKey,
  });

  const request = zOpenAIRequestSchema.safeParse(job.data);
  if (!request.success) {
    throw new Error(
      `[openai][${jobId}] Got malformed job request: ${request.error.toString()}`,
    );
  }

  const { bookmarkId } = request.data;
  const bookmark = await fetchBookmark(bookmarkId);
  if (!bookmark) {
    throw new Error(
      `[openai][${jobId}] bookmark with id ${bookmarkId} was not found`,
    );
  }

  const tags = await inferTags(jobId, bookmark, openai);

  await connectTags(bookmarkId, tags, bookmark.userId);

  // Update the search index
  SearchIndexingQueue.add("search_indexing", {
    bookmarkId,
    type: "index",
  });
}
