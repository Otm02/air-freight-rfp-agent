import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  timeoutMs?: number;
}

export interface SmtpMessage {
  to: string;
  from?: string;
  subject: string;
  text: string;
  markdown?: string;
}

export interface SmtpSendResult {
  accepted: boolean;
  messageId: string;
  response: string;
}

export interface SmtpTransport {
  sendMail(message: SmtpMessage): Promise<SmtpSendResult>;
}

export function readSmtpConfig(
  env: Record<string, string | undefined> = process.env,
): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) {
    return null;
  }

  const secureRaw = env.SMTP_SECURE?.trim().toLowerCase();
  const secure = secureRaw === "true" || secureRaw === "1";

  const portRaw = env.SMTP_PORT?.trim();
  const parsedPort = portRaw ? Number.parseInt(portRaw, 10) : NaN;
  const port = Number.isFinite(parsedPort) && parsedPort > 0
    ? parsedPort
    : secure
      ? 465
      : 587;

  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS?.trim() || undefined;
  const from =
    env.SMTP_FROM?.trim() || user || "rfp-response-team@carrier.example";

  return { host, port, secure, user, pass, from };
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function normalizeCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}

function dotStuffSmtpBody(rawMessage: string): string {
  return normalizeCrlf(rawMessage)
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

export function buildMimeEmailPayload(
  message: SmtpMessage,
  defaultFrom: string,
): { from: string; to: string; messageId: string; rawPayload: string } {
  const from = sanitizeHeaderValue(message.from ?? defaultFrom);
  const to = sanitizeHeaderValue(message.to);
  const subject = sanitizeHeaderValue(message.subject);
  const messageId = `<${randomUUID()}@air-freight-rfp-agent>`;
  const dateHeader = new Date().toUTCString();

  const headers = [
    `Date: ${dateHeader}`,
    `Message-ID: ${messageId}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
  ];

  if (message.markdown && message.markdown !== message.text) {
    const boundary = `----=_Part_${randomUUID().replace(/-/g, "")}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const parts = [
      ...headers,
      "",
      `--${boundary}`,
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      normalizeCrlf(message.text),
      "",
      `--${boundary}`,
      'Content-Type: text/markdown; charset="utf-8"',
      "Content-Transfer-Encoding: 8bit",
      "",
      normalizeCrlf(message.markdown),
      "",
      `--${boundary}--`,
      "",
    ];
    return {
      from,
      to,
      messageId,
      rawPayload: dotStuffSmtpBody(parts.join("\r\n")),
    };
  }

  headers.push('Content-Type: text/plain; charset="utf-8"');
  headers.push("Content-Transfer-Encoding: 8bit");

  return {
    from,
    to,
    messageId,
    rawPayload: dotStuffSmtpBody([...headers, "", message.text, ""].join("\r\n")),
  };
}

interface SmtpResponse {
  code: number;
  lines: string[];
  raw: string;
}

class SmtpLineReader {
  private socket: net.Socket | tls.TLSSocket;
  private buffer = "";
  private pendingLines: string[] = [];
  private waiter: (() => void) | null = null;
  private endedError: Error | null = null;

  constructor(socket: net.Socket | tls.TLSSocket) {
    this.socket = socket;
    this.attachListeners(socket);
  }

  rebindSocket(newSocket: tls.TLSSocket): void {
    this.socket.removeAllListeners("data");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("close");
    this.socket = newSocket;
    this.buffer = "";
    this.attachListeners(newSocket);
  }

  private attachListeners(sock: net.Socket | tls.TLSSocket): void {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        this.pendingLines.push(line);
        idx = this.buffer.indexOf("\n");
      }
      if (this.pendingLines.length > 0 && this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    });
    sock.on("error", (err: Error) => {
      this.endedError = err;
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    });
    sock.on("close", () => {
      if (!this.endedError) {
        this.endedError = new Error("SMTP connection closed unexpectedly");
      }
      if (this.waiter) {
        const wake = this.waiter;
        this.waiter = null;
        wake();
      }
    });
  }

  private async nextLine(): Promise<string> {
    while (this.pendingLines.length === 0) {
      if (this.endedError) {
        throw this.endedError;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
    return this.pendingLines.shift()!;
  }

  async readResponse(): Promise<SmtpResponse> {
    const lines: string[] = [];
    while (true) {
      const line = await this.nextLine();
      lines.push(line);
      if (line.length >= 4 && line[3] === "-") {
        continue;
      }
      const code = Number.parseInt(line.slice(0, 3), 10);
      if (!Number.isFinite(code)) {
        throw new Error(`Invalid SMTP server response: ${line}`);
      }
      return { code, lines, raw: lines.join("\n") };
    }
  }

  async sendCommand(command: string, expectedCodes: number[]): Promise<SmtpResponse> {
    this.socket.write(`${command}\r\n`);
    const resp = await this.readResponse();
    if (!expectedCodes.includes(resp.code)) {
      throw new Error(
        `SMTP command "${command.split(" ")[0]}" failed with ${resp.code}: ${resp.raw}`,
      );
    }
    return resp;
  }

  async sendData(payload: string): Promise<SmtpResponse> {
    this.socket.write(`${payload}\r\n.\r\n`);
    const resp = await this.readResponse();
    if (resp.code !== 250) {
      throw new Error(`SMTP DATA rejected with ${resp.code}: ${resp.raw}`);
    }
    return resp;
  }
}

export function createNodeSmtpTransport(config: SmtpConfig): SmtpTransport {
  const timeoutMs = config.timeoutMs ?? 15_000;

  return {
    async sendMail(message: SmtpMessage): Promise<SmtpSendResult> {
      const built = buildMimeEmailPayload(message, config.from);

      const socket: net.Socket | tls.TLSSocket = await new Promise(
        (resolve, reject) => {
          const onError = (err: Error) => reject(err);
          if (config.secure) {
            const s = tls.connect(
              { host: config.host, port: config.port, servername: config.host },
              () => {
                s.removeListener("error", onError);
                resolve(s);
              },
            );
            s.setTimeout(timeoutMs, () => s.destroy(new Error("SMTP connection timeout")));
            s.once("error", onError);
          } else {
            const s = net.connect({ host: config.host, port: config.port }, () => {
              s.removeListener("error", onError);
              resolve(s);
            });
            s.setTimeout(timeoutMs, () => s.destroy(new Error("SMTP connection timeout")));
            s.once("error", onError);
          }
        },
      );

      let currentSocket: net.Socket | tls.TLSSocket = socket;
      const reader = new SmtpLineReader(socket);

      try {
        const greeting = await reader.readResponse();
        if (greeting.code !== 220) {
          throw new Error(`SMTP greeting error ${greeting.code}: ${greeting.raw}`);
        }

        const ehloResp = await reader.sendCommand("EHLO air-freight-rfp-agent", [250]);
        const supportsStartTls = ehloResp.lines.some((line) =>
          line.toUpperCase().includes("STARTTLS"),
        );

        if (!config.secure && supportsStartTls) {
          await reader.sendCommand("STARTTLS", [220]);
          const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
            const tlsSock = tls.connect(
              { socket: currentSocket, servername: config.host },
              () => resolve(tlsSock),
            );
            tlsSock.once("error", reject);
          });
          currentSocket = upgraded;
          reader.rebindSocket(upgraded);
          await reader.sendCommand("EHLO air-freight-rfp-agent", [250]);
        }

        if (config.user && config.pass) {
          const token = Buffer.from(
            `\0${config.user}\0${config.pass}`,
            "utf8",
          ).toString("base64");
          await reader.sendCommand(`AUTH PLAIN ${token}`, [235]);
        }

        await reader.sendCommand(`MAIL FROM:<${built.from}>`, [250]);
        await reader.sendCommand(`RCPT TO:<${built.to}>`, [250, 251]);
        await reader.sendCommand("DATA", [354]);
        const dataResp = await reader.sendData(built.rawPayload);

        try {
          await reader.sendCommand("QUIT", [221]);
        } catch {
          // Ignore server hangup after successful DATA acceptance
        }

        return {
          accepted: true,
          messageId: built.messageId,
          response: dataResp.raw,
        };
      } finally {
        if (!currentSocket.destroyed) {
          currentSocket.destroy();
        }
      }
    },
  };
}
