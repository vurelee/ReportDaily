import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { config } from "./temu-config.mjs";
import { connectCdpChrome, cdpEndpoint } from "./chrome-cdp.mjs";
import { closeCdpPages } from "./cdp-page-cleanup.mjs";

const { browser, context, page } = await connectCdpChrome(config.temuHomeUrl);
await page.goto(config.temuHomeUrl, { waitUntil: "domcontentloaded" }).catch(() => {});

console.log(`Chrome CDP profile dir: ${config.cdpProfileDir}`);
console.log(`Chrome CDP endpoint: ${cdpEndpoint}`);
console.log("请在打开的普通 Chrome 窗口里完成 Temu 登录和短信验证。");

const rl = readline.createInterface({ input, output });
await rl.question("登录完成并确认能进入 Temu 广告后台后，回到这里按 Enter...");
rl.close();

console.log("CDP Chrome 登录状态已保存在专用 profile。");
await closeCdpPages(context);
await browser.close().catch(() => {});
