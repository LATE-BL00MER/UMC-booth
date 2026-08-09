export interface SavePhotoDependencies {
  document: Document;
  navigator: Navigator;
  url: typeof URL;
}

export async function savePhoto(
  blob: Blob,
  filename: string,
  dependencies: SavePhotoDependencies = {
    document,
    navigator,
    url: URL,
  },
): Promise<void> {
  const file = new File([blob], filename, { type: blob.type || "image/jpeg" });
  const { navigator: browserNavigator } = dependencies;

  if (
    typeof browserNavigator.canShare === "function"
    && typeof browserNavigator.share === "function"
    && browserNavigator.canShare({ files: [file] })
  ) {
    await browserNavigator.share({ files: [file] });
    return;
  }

  const objectUrl = dependencies.url.createObjectURL(blob);
  const anchor = dependencies.document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => dependencies.url.revokeObjectURL(objectUrl), 0);
}
