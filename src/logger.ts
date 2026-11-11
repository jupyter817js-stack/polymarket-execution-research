import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";

import pino from "pino";
import pretty from "pino-pretty";

import { config } from "./config.js";

const formatLogDate = (value: Date): string => {
  const year = String(value.getFullYear()).slice(-2);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}_${month}_${day}`;
};

const logsDir = path.resolve(process.cwd(), "logs");
mkdirSync(logsDir, { recursive: true });

export const logFilePath = path.join(logsDir, `log_${formatLogDate(new Date())}.txt`);

const ensureTrailingNewline = (filePath: string): void => {
  if (!existsSync(filePath)) {
    return;
  }

  const { size } = statSync(filePath);

  if (size === 0) {
    return;
  }

  const descriptor = openSync(filePath, "r");
  const buffer = Buffer.alloc(1);

  try {
    readSync(descriptor, buffer, 0, 1, size - 1);
  } finally {
    closeSync(descriptor);
  }

  if (buffer[0] !== 0x0a) {
    appendFileSync(filePath, "\n");
  }
};

ensureTrailingNewline(logFilePath);

const prettyOptions = {
  translateTime: "SYS:standard",
  ignore: "pid,hostname"
} as const;

const consoleStream = pretty({
  ...prettyOptions,
  colorize: true
});

const fileStream = pretty({
  ...prettyOptions,
  colorize: false,
  destination: logFilePath,
  mkdir: true
});

// Use the lower of the two configured levels as the root logger level
// so that pino does not discard records before they reach the per-stream filter.
const pinoLevelOrder = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
type PinoLevel = (typeof pinoLevelOrder)[number];
const minLevel = (a: PinoLevel, b: PinoLevel): PinoLevel => {
  const ai = pinoLevelOrder.indexOf(a);
  const bi = pinoLevelOrder.indexOf(b);
  return ai <= bi ? a : b;
};

export const logger = pino(
  {
    level: minLevel(config.logLevel as PinoLevel, config.fileLogLevel as PinoLevel)
  },
  pino.multistream([
    { stream: consoleStream, level: config.logLevel },
    { stream: fileStream, level: config.fileLogLevel }
  ])
);
