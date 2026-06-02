import { execFile } from "node:child_process";

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 1) {
          resolve("");
          return;
        }
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function cdpPortPids(port) {
  if (!Number.isFinite(Number(port))) return [];
  const stdout = await execFileText("lsof", [
    "-tiTCP:" + String(port),
    "-sTCP:LISTEN",
  ]).catch(() => "");
  return stdout
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value));
}

async function waitForNoCdpListener(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await cdpPortPids(port)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return (await cdpPortPids(port)).length === 0;
}

export async function closeCdpPages(context) {
  if (process.env.TEMU_CLOSE_CHROME_PAGES === "0") return 0;

  let closed = 0;
  for (const page of [...context.pages()].reverse()) {
    if (page.isClosed()) continue;

    await page
      .close({ runBeforeUnload: false })
      .then(() => {
        closed += 1;
      })
      .catch(() => {});
  }

  return closed;
}

export async function closeCdpChromeProcess(port) {
  if (process.env.TEMU_CLOSE_CHROME_PROCESS === "0") return [];

  const pids = await cdpPortPids(port);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have exited between lsof and kill.
    }
  }

  await waitForNoCdpListener(port);
  return pids;
}
