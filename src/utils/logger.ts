import pino, { type Logger } from "pino";
import { env } from "../env.js";

const isDev = env.NODE_ENV !== "production";

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});
