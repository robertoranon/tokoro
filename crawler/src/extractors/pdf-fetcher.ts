import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';
import type { ImageData } from './image-fetcher.js';

const TEXT_DENSITY_THRESHOLD = 200;
const MAX_IMAGE_PAGES = 10;
const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export type PdfData =
  | { type: 'text'; text: string; pageCount: number }
  | { type: 'images'; pages: ImageData[]; pageCount: number };

/** Returns true if text has at least 200 non-whitespace characters. */
export function isTextDense(text: string): boolean {
  return text.replace(/\s/g, '').length >= TEXT_DENSITY_THRESHOLD;
}

export class PdfFetcher {
  async loadPdf(source: string): Promise<PdfData> {
    const buffer =
      source.startsWith('http://') || source.startsWith('https://')
        ? await this.fetchFromUrl(source)
        : await this.loadFromFile(source);

    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    (pdfjsLib as any).GlobalWorkerOptions.workerSrc = '';

    const pdfDoc = await (pdfjsLib as any).getDocument({
      data: new Uint8Array(buffer),
    }).promise;

    const pageCount: number = pdfDoc.numPages;

    // Extract text from all pages
    let text = '';
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdfDoc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = (textContent.items as any[])
        .map((item: any) => ('str' in item ? item.str : ''))
        .join(' ');
      text += pageText + '\n';
    }

    const nonWhitespace = text.replace(/\s/g, '').length;
    console.log(
      `  PDF: ${pageCount} page(s), ${nonWhitespace} non-whitespace chars`
    );

    if (isTextDense(text)) {
      console.log('  → Text path');
      await pdfDoc.destroy();
      return { type: 'text', text, pageCount };
    }

    console.log('  → Image fallback (sparse text)');
    const pages = await this.renderToImages(pdfDoc, source, pageCount);
    await pdfDoc.destroy();
    return { type: 'images', pages, pageCount };
  }

  private async loadFromFile(filePath: string): Promise<Buffer> {
    console.log(`Loading PDF from file: ${filePath}`);
    const buffer = await fs.readFile(path.resolve(filePath));
    if (buffer.length > MAX_PDF_SIZE_BYTES) {
      throw new Error(
        `PDF too large: ${Math.round(buffer.length / 1024 / 1024)}MB exceeds 50MB limit`
      );
    }
    return buffer;
  }

  private async fetchFromUrl(url: string): Promise<Buffer> {
    console.log(`Fetching PDF from URL: ${url}`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch PDF: ${response.status} ${response.statusText}`
      );
    }
    const buffer = await response.buffer();
    if (buffer.length > MAX_PDF_SIZE_BYTES) {
      throw new Error(
        `PDF too large: ${Math.round(buffer.length / 1024 / 1024)}MB exceeds 50MB limit`
      );
    }
    return buffer;
  }

  private async renderToImages(
    pdfDoc: any,
    source: string,
    totalPages: number
  ): Promise<ImageData[]> {
    const { createCanvas } = await import('@napi-rs/canvas');

    const pagesToRender = Math.min(totalPages, MAX_IMAGE_PAGES);
    if (totalPages > MAX_IMAGE_PAGES) {
      console.warn(
        `  ⚠ PDF has ${totalPages} pages; rendering first ${MAX_IMAGE_PAGES} only`
      );
    }

    const pages: ImageData[] = [];

    for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = createCanvas(
        Math.floor(viewport.width),
        Math.floor(viewport.height)
      );
      const context = canvas.getContext('2d');

      await page.render({
        canvasContext: context as any,
        viewport,
      }).promise;

      const base64 = (canvas as any).toBuffer('image/png').toString('base64');
      pages.push({ base64, mimeType: 'image/png', source });
      console.log(`  Rendered page ${pageNum}/${pagesToRender}`);
    }

    return pages;
  }
}
