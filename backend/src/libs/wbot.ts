import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeInMemoryStore,
  isJidBroadcast,
  CacheStore,
  WAMessageKey,
  WAMessageContent,
  proto
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import NodeCache from "node-cache";
import { Op } from "sequelize";
import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import authState from "../helpers/authState";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import Contact from "../models/Contact";
import Ticket from "../models/Ticket";

const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "error";

type Session = WASocket & {
  id?: number;
  store?: Store;
};

const sessions: Session[] = [];

const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);

  if (sessionIndex === -1) {
    throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  }
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }

      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise((resolve, reject) => {
    try {
      (async () => {
        const io = getIO();

        const whatsappUpdate = await Whatsapp.findOne({
          where: { id: whatsapp.id }
        });

        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;

        const { version, isLatest } = await fetchLatestBaileysVersion();
        const isLegacy = provider === "stable";

        logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
        logger.info(`isLegacy: ${isLegacy}`);
        logger.info(`Starting session ${name}`);
        let retriesQrCode = 0;

        let wsocket: Session = null;
        const store = makeInMemoryStore({
          logger: loggerBaileys
        });

        async function getMessage(
          key: WAMessageKey
        ): Promise<WAMessageContent | undefined> {
          if (store) {
            const msg = await store.loadMessage(key.remoteJid!, key.id!);
            logger.debug(
              { key, message: JSON.stringify(msg) },
              `[wbot.ts] getMessage: result of recovering message ${key.remoteJid} ${key.id}`
            );
            return msg?.message || undefined;
          }

          // only if store isn't present
          return proto.Message.fromObject({});
        }

        const { state, saveState } = await authState(whatsapp);

        const msgRetryCounterCache = new NodeCache();
        const userDevicesCache: CacheStore = new NodeCache();

        wsocket = makeWASocket({
          logger: loggerBaileys,
          printQRInTerminal: false,
          browser: Browsers.appropriate("Desktop"),
          auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys)
          },
          version,
          defaultQueryTimeoutMs: 60000,
          // retryRequestDelayMs: 250,
          // keepAliveIntervalMs: 1000 * 60 * 10 * 3,
          msgRetryCounterCache,
          // syncFullHistory: true,
          generateHighQualityLinkPreview: true,
          userDevicesCache,
          getMessage,
          shouldIgnoreJid: jid =>
            isJidBroadcast(jid) || jid?.endsWith("@newsletter"),
          transactionOpts: { maxCommitRetries: 1, delayBetweenTriesMs: 10 }
        });

        // wsocket = makeWASocket({
        //   version,
        //   logger: loggerBaileys,
        //   printQRInTerminal: false,
        //   auth: state as AuthenticationState,
        //   generateHighQualityLinkPreview: false,
        //   shouldIgnoreJid: jid => isJidBroadcast(jid),
        //   browser: ["Chat", "Chrome", "10.15.7"],
        //   patchMessageBeforeSending: (message) => {
        //     const requiresPatch = !!(
        //       message.buttonsMessage ||
        //       // || message.templateMessage
        //       message.listMessage
        //     );
        //     if (requiresPatch) {
        //       message = {
        //         viewOnceMessage: {
        //           message: {
        //             messageContextInfo: {
        //               deviceListMetadataVersion: 2,
        //               deviceListMetadata: {},
        //             },
        //             ...message,
        //           },
        //         },
        //       };
        //     }

        //     return message;
        //   },
        // })

        wsocket.ev.on(
          "connection.update",
          async ({ connection, lastDisconnect, qr }) => {
            logger.info(
              `Socket  ${name} Connection Update ${connection || ""} ${
                lastDisconnect || ""
              }`
            );

            if (connection === "close") {
              if ((lastDisconnect?.error as Boom)?.output?.statusCode === 403) {
                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
              }
              if (
                (lastDisconnect?.error as Boom)?.output?.statusCode !==
                DisconnectReason.loggedOut
              ) {
                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              } else {
                await whatsapp.update({ status: "PENDING", session: "" });
                await DeleteBaileysService(whatsapp.id);
                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
                removeWbot(id, false);
                setTimeout(
                  () => StartWhatsAppSession(whatsapp, whatsapp.companyId),
                  2000
                );
              }
            }

            if (connection === "open") {
              await whatsapp.update({
                status: "CONNECTED",
                qrcode: "",
                retries: 0
              });

              io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                action: "update",
                session: whatsapp
              });

              const sessionIndex = sessions.findIndex(
                s => s.id === whatsapp.id
              );
              if (sessionIndex === -1) {
                wsocket.id = whatsapp.id;
                sessions.push(wsocket);
              }

              resolve(wsocket);
            }

            if (qr !== undefined) {
              if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                await whatsappUpdate.update({
                  status: "DISCONNECTED",
                  qrcode: ""
                });
                await DeleteBaileysService(whatsappUpdate.id);
                io.emit("whatsappSession", {
                  action: "update",
                  session: whatsappUpdate
                });
                wsocket.ev.removeAllListeners("connection.update");
                wsocket.ws.close();
                wsocket = null;
                retriesQrCodeMap.delete(id);
              } else {
                logger.info(`Session QRCode Generate ${name}`);
                retriesQrCodeMap.set(id, (retriesQrCode += 1));

                await whatsapp.update({
                  qrcode: qr,
                  status: "qrcode",
                  retries: 0
                });
                const sessionIndex = sessions.findIndex(
                  s => s.id === whatsapp.id
                );

                if (sessionIndex === -1) {
                  wsocket.id = whatsapp.id;
                  sessions.push(wsocket);
                }

                io.emit(`company-${whatsapp.companyId}-whatsappSession`, {
                  action: "update",
                  session: whatsapp
                });
              }
            }
          }
        );
        wsocket.ev.on("creds.update", saveState);

        wsocket.ev.on(
          "presence.update",
          async ({ id: remoteJid, presences }) => {
            try {
              logger.debug(
                { remoteJid, presences },
                "Received contact presence"
              );
              if (!presences[remoteJid]?.lastKnownPresence) {
                // ignore presence from groups
                return;
              }
              const contact = await Contact.findOne({
                where: {
                  number: remoteJid.replace(/\D/g, ""),
                  companyId: whatsapp.companyId
                }
              });
              if (!contact) {
                return;
              }
              const ticket = await Ticket.findOne({
                where: {
                  contactId: contact.id,
                  whatsappId: whatsapp.id,
                  status: {
                    [Op.or]: ["open", "pending"]
                  }
                }
              });

              if (ticket) {
                io.to(ticket.id.toString())
                  .to(`company-${whatsapp.companyId}-${ticket.status}`)
                  .to(`queue-${ticket.queueId}-${ticket.status}`)
                  .emit(`company-${whatsapp.companyId}-presence`, {
                    ticketId: ticket.id,
                    presence: presences[remoteJid].lastKnownPresence
                  });
              }
            } catch (error) {
              logger.error(
                { remoteJid, presences },
                "presence.update: error processing"
              );
              if (error instanceof Error) {
                logger.error(`Error: ${error.name} ${error.message}`);
              } else {
                logger.error(`Error was object of type: ${typeof error}`);
              }
            }
          }
        );

        store.bind(wsocket.ev);
      })();
    } catch (error) {
      Sentry.captureException(error);
      console.log(error);
      reject(error);
    }
  });
};
