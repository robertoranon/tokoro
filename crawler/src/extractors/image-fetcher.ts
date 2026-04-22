import * as fs from 'fs/promises';
import * as path from 'path';
import fetch from 'node-fetch';

export interface ImageData {
  base64: string;
  mimeType: string;
  source: string;
}

export class ImageFetcher {
  /**
   * Load an image from a file path or URL
   */
  async loadImage(source: string): Promise<ImageData> {
    // Check if it's a URL or file path
    if (source.startsWith('http://') || source.startsWith('https://')) {
      return this.loadImageFromUrl(source);
    } else {
      return this.loadImageFromFile(source);
    }
  }

  /**
   * Load an image from a local file
   */
  private async loadImageFromFile(filePath: string): Promise<ImageData> {
    console.log(`Loading image from file: ${filePath}`);

    // Resolve to absolute path
    const absolutePath = path.resolve(filePath);

    // Read the file
    const buffer = await fs.readFile(absolutePath);

    // Convert to base64
    const base64 = buffer.toString('base64');

    // Detect MIME type from file extension
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = this.getMimeTypeFromExtension(ext);

    console.log(`Loaded ${buffer.length} bytes, MIME type: ${mimeType}`);

    return {
      base64,
      mimeType,
      source: filePath,
    };
  }

  /**
   * Load an image from a URL
   */
  private async loadImageFromUrl(url: string): Promise<ImageData> {
    console.log(`Fetching image from URL: ${url}`);

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Failed to fetch image: ${response.status} ${response.statusText}`
      );
    }

    // Get the buffer
    const buffer = await response.buffer();

    // Convert to base64
    const base64 = buffer.toString('base64');

    // Get MIME type from response headers or URL
    let mimeType = response.headers.get('content-type') || '';
    if (!mimeType || !mimeType.startsWith('image/')) {
      // Try to detect from URL extension
      const ext = path.extname(new URL(url).pathname).toLowerCase();
      mimeType = this.getMimeTypeFromExtension(ext);
    }

    console.log(`Fetched ${buffer.length} bytes, MIME type: ${mimeType}`);

    return {
      base64,
      mimeType,
      source: url,
    };
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeTypeFromExtension(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
    };

    return mimeTypes[ext] || 'image/jpeg'; // Default to JPEG
  }
}
