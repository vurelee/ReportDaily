import { chromium } from "playwright";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config } from "./temu-config.mjs";

const context = await chromium.launchPersistentContext(config.profileDir, {
  channel: "chrome",
  headless: false,
  viewport: null,
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" });

console.log(`Temu profile dir: ${config.profileDir}`);
console.log("请在打开的 Chrome 窗口里完成 Temu 登录和短信验证。");

const rl = readline.createInterface({ input, output });
await rl.question("登录完成并确认能进入 Temu 广告后台后，回到这里按 Enter 保存 profile...");
rl.close();

await context.close();
console.log("登录状态已保存。后续巡检会复用这个专用 profile。");
