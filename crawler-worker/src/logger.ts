/**
 * File-based logger for crawler-worker
 * Writes operational logs to R2 (Cloudflare object storage)
 */

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  operation: string;
  message: string;
  details?: any;
  url?: string;
}

export class CrawlerLogger {
  private logs: LogEntry[] = [];
  private r2Bucket?: R2Bucket;
  private sessionId: string;

  constructor(r2Bucket?: R2Bucket) {
    this.r2Bucket = r2Bucket;
    this.sessionId = this.generateSessionId();
  }

  private generateSessionId(): string {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}_${random}`;
  }

  /**
   * Log an informational message
   */
  info(operation: string, message: string, details?: any, url?: string): void {
    this.addLog('info', operation, message, details, url);
    console.log(`[${operation}] ${message}`, details ? details : '');
  }

  /**
   * Log a warning message
   */
  warn(operation: string, message: string, details?: any, url?: string): void {
    this.addLog('warn', operation, message, details, url);
    console.warn(`[${operation}] ${message}`, details ? details : '');
  }

  /**
   * Log an error message
   */
  error(operation: string, message: string, details?: any, url?: string): void {
    this.addLog('error', operation, message, details, url);
    console.error(`[${operation}] ${message}`, details ? details : '');
  }

  /**
   * Add a log entry to the buffer
   */
  private addLog(
    level: 'info' | 'warn' | 'error',
    operation: string,
    message: string,
    details?: any,
    url?: string
  ): void {
    this.logs.push({
      timestamp: new Date().toISOString(),
      level,
      operation,
      message,
      details,
      url,
    });
  }

  /**
   * Flush logs to R2
   * Call this at the end of a crawl session
   */
  async flush(): Promise<void> {
    if (!this.r2Bucket) {
      console.warn('No R2 bucket configured, logs will not be persisted to file');
      return;
    }

    if (this.logs.length === 0) {
      return;
    }

    try {
      const logContent = this.formatLogs();
      const logKey = `crawler-logs/${this.sessionId}.log`;

      await this.r2Bucket.put(logKey, logContent, {
        httpMetadata: {
          contentType: 'text/plain',
        },
      });

      console.log(`📝 Logs written to R2: ${logKey}`);
    } catch (error) {
      console.error('Failed to write logs to R2:', error);
    }
  }

  /**
   * Format logs as human-readable text
   */
  private formatLogs(): string {
    const header = `=== CRAWLER-WORKER LOG ===
Session ID: ${this.sessionId}
Started: ${this.logs[0]?.timestamp || 'unknown'}
Entries: ${this.logs.length}

=== LOG ENTRIES ===

`;

    const entries = this.logs
      .map(entry => {
        const level = entry.level.toUpperCase().padEnd(5);
        const timestamp = entry.timestamp;
        const operation = entry.operation.padEnd(20);
        let line = `[${timestamp}] [${level}] [${operation}] ${entry.message}`;

        if (entry.url) {
          line += `\n  URL: ${entry.url}`;
        }

        if (entry.details) {
          const detailsStr =
            typeof entry.details === 'string'
              ? entry.details
              : JSON.stringify(entry.details, null, 2);
          line += `\n  Details: ${detailsStr}`;
        }

        return line;
      })
      .join('\n\n');

    const footer = `\n\n=== END OF LOG ===\n`;

    return header + entries + footer;
  }

  /**
   * Get summary statistics from logs
   */
  getSummary(): {
    total: number;
    info: number;
    warn: number;
    error: number;
  } {
    return {
      total: this.logs.length,
      info: this.logs.filter(l => l.level === 'info').length,
      warn: this.logs.filter(l => l.level === 'warn').length,
      error: this.logs.filter(l => l.level === 'error').length,
    };
  }
}
