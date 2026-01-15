
type LogLevel = 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  details?: any;
}

type LogListener = (entry: LogEntry) => void;

class LoggerService {
  private listeners: LogListener[] = [];
  private logs: LogEntry[] = [];
  private maxLogs: number = 1000;

  constructor() {}

  subscribe(listener: LogListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }

  clear() {
    this.logs = [];
    this.notify({ timestamp: Date.now(), level: 'info', message: 'Logs cleared' });
  }

  private notify(entry: LogEntry) {
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    this.listeners.forEach(listener => listener(entry));
  }

  info(message: string, details?: any) {
    this.notify({ timestamp: Date.now(), level: 'info', message, details });
    console.log(`[INFO] ${message}`, details || '');
  }

  success(message: string, details?: any) {
    this.notify({ timestamp: Date.now(), level: 'success', message, details });
    console.log(`[SUCCESS] ${message}`, details || '');
  }

  warn(message: string, details?: any) {
    this.notify({ timestamp: Date.now(), level: 'warn', message, details });
    console.warn(`[WARN] ${message}`, details || '');
  }

  error(message: string, details?: any) {
    this.notify({ timestamp: Date.now(), level: 'error', message, details });
    console.error(`[ERROR] ${message}`, details || '');
  }
}

export const logger = new LoggerService();
