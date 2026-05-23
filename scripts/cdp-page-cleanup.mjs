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
