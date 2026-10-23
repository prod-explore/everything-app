import type * as Llm from './llm-types.js';

/**
 * Images that come back from a tool (a browser screenshot today, a screen capture of the user's computer later).
 * They travel as `image` blocks inside the `tool_result`, are stored with the message like an attached image, and are
 * described by a vision model for a model that cannot read images (see vision.ts).
 */
export type ImageMediaType = Extract<Llm.ImageBlockParam['source'], { type: 'base64' }>['media_type'];

export interface ToolImage {
  mediaType: ImageMediaType;
  /** Base64, no `data:` prefix. */
  data: string;
}

/** A tool result carries a handful of images at most. */
export const MAX_IMAGES_PER_RESULT = 4;
/** Base64 characters per image (~4 MB of picture): bigger ones are left out, so one capture cannot flood the chat or the database. */
export const MAX_IMAGE_CHARS = 5_500_000;
const ALLOWED_TYPE = /^image\/(png|jpe?g|webp|gif)$/i;

interface McpContentBlock {
  type: string;
  data?: unknown;
  mimeType?: unknown;
}

/** The usable images of an MCP result, and a note for each one that had to be left out. */
export function pickImages(content: readonly McpContentBlock[]): { images: ToolImage[]; notes: string[] } {
  const images: ToolImage[] = [];
  const notes: string[] = [];
  for (const block of content) {
    if (block.type !== 'image') continue;
    const claimed = typeof block.mimeType === 'string' ? block.mimeType.toLowerCase() : '';
    const data = typeof block.data === 'string' ? block.data : '';
    if (!ALLOWED_TYPE.test(claimed)) {
      notes.push(`[an image of type ${claimed || 'unknown'} was left out: only PNG, JPEG, WebP and GIF are accepted]`);
    } else if (!data) {
      notes.push('[an empty image was left out]');
    } else if (data.length > MAX_IMAGE_CHARS) {
      notes.push(`[an image of ${Math.round((data.length * 3) / 4 / 1024).toLocaleString('en-US')} KB was left out: too large]`);
    } else if (images.length >= MAX_IMAGES_PER_RESULT) {
      notes.push(`[more than ${MAX_IMAGES_PER_RESULT} images came back; the rest were left out]`);
    } else {
      images.push({ mediaType: (claimed === 'image/jpg' ? 'image/jpeg' : claimed) as ImageMediaType, data });
    }
  }
  return { images, notes: [...new Set(notes)] };
}

/** The `content` of a tool_result: plain text, or text followed by the images. */
export function toolResultContent(text: string, images?: readonly ToolImage[]): string | Array<Llm.TextBlockParam | Llm.ImageBlockParam> {
  if (!images || images.length === 0) return text;
  return [
    { type: 'text', text },
    ...images.map((i): Llm.ImageBlockParam => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
  ];
}
