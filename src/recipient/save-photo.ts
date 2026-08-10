export interface SavePhotoDependencies {
  document: Document;
  url: typeof URL;
}

export async function savePhoto(
  blob: Blob,
  filename: string,
  dependencies: SavePhotoDependencies = {
    document,
    url: URL,
  },
): Promise<void> {
  const objectUrl = dependencies.url.createObjectURL(blob);
  try {
    const anchor = dependencies.document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
  } finally {
    setTimeout(() => dependencies.url.revokeObjectURL(objectUrl), 0);
  }
}
