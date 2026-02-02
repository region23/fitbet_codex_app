import fs from "node:fs/promises";
import path from "node:path";

export type FileStore = {
  downloadToFile: (url: string, destinationPath: string) => Promise<void>;
};

export function createTelegramFileStore(opts?: { download?: typeof fetch }): FileStore {
  const download = opts?.download ?? fetch;

  return {
    async downloadToFile(url, destinationPath) {
      const res = await download(url);
      if (!res.ok) throw new Error(`Не удалось скачать файл: ${res.status} ${res.statusText}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.writeFile(destinationPath, buffer);
    }
  };
}
