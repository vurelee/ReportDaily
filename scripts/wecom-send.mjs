import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { config } from "./temu-config.mjs";

const DEFAULT_MAX_TEXT_BYTES = 1900;

export async function sendWecomText(text, options = {}) {
  if (!config.wecomWebhookUrl) {
    throw new Error("WECOM_WEBHOOK_URL is required to send Enterprise WeChat webhook messages");
  }

  const chunks = splitTextByBytes(text, options.maxBytes || DEFAULT_MAX_TEXT_BYTES);
  for (const chunk of chunks) {
    await sendWecomWebhook({
      msgtype: "text",
      text: { content: chunk },
    });
  }
}

export async function sendWecomMarkdown(markdown) {
  if (!config.wecomWebhookUrl) {
    throw new Error("WECOM_WEBHOOK_URL is required to send Enterprise WeChat webhook messages");
  }

  await sendWecomWebhook({
    msgtype: "markdown",
    markdown: { content: markdown },
  });
}

export async function sendWecomMarkdownV2(markdown) {
  if (!config.wecomWebhookUrl) {
    throw new Error("WECOM_WEBHOOK_URL is required to send Enterprise WeChat webhook messages");
  }

  await sendWecomWebhook({
    msgtype: "markdown_v2",
    markdown_v2: { content: markdown },
  });
}

export async function sendWecomImage(imagePath) {
  if (!config.wecomWebhookUrl) {
    throw new Error("WECOM_WEBHOOK_URL is required to send Enterprise WeChat images");
  }

  const image = await fs.readFile(imagePath);
  if (image.byteLength > 2 * 1024 * 1024) {
    throw new Error("Enterprise WeChat webhook image must be <= 2MB before base64 encoding");
  }

  await sendWecomWebhook({
    msgtype: "image",
    image: {
      base64: image.toString("base64"),
      md5: crypto.createHash("md5").update(image).digest("hex"),
    },
  });
}

async function sendWecomWebhook(payload) {
  const response = await fetch(config.wecomWebhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Enterprise WeChat webhook returned non-JSON response: HTTP ${response.status}`);
  }

  if (!response.ok || body.errcode !== 0) {
    throw new Error(
      `Enterprise WeChat webhook failed: HTTP ${response.status} errcode=${body.errcode} errmsg=${body.errmsg || ""}`,
    );
  }

  return body;
}

function splitTextByBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return [text];

  const chunks = [];
  let current = "";

  for (const line of text.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (Buffer.byteLength(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (Buffer.byteLength(line) <= maxBytes) {
      current = line;
      continue;
    }

    let partial = "";
    for (const char of line) {
      const next = `${partial}${char}`;
      if (Buffer.byteLength(next) > maxBytes) {
        chunks.push(partial);
        partial = char;
      } else {
        partial = next;
      }
    }
    current = partial;
  }

  if (current) chunks.push(current);
  return chunks;
}
