import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  prepareWAMessageMedia,
  generateWAMessageFromContent,
  jidNormalizedUser,
  proto
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import ffmpegPath from 'ffmpeg-static';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);
const processedIds = new Set();
const MAX_DURATION = 10;

function unwrapMessage(message) {
  return (
    message?.ephemeralMessage?.message ||
    message?.viewOnceMessage?.message ||
    message?.viewOnceMessageV2?.message ||
    message
  );
}

async function getMediaDuration(filePath) {
  const parseDuration = (stderrText) => {
    const match = stderrText?.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!match) return null;
    return (
      parseInt(match[1], 10) * 3600 +
      parseInt(match[2], 10) * 60 +
      parseFloat(match[3])
    );
  };

  try {
    const { stderr } = await execAsync(`"${ffmpegPath}" -i "${filePath}" -f null -`);
    return parseDuration(stderr) ?? 5;
  } catch (err) {
    return parseDuration(err.stderr) ?? 5;
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('sesi_wa');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan QR code ini lewat WhatsApp di HP kamu:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi putus, nyambungin ulang:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('Bot udah konek dan siap dipakai!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const rawMsg of messages) {
      if (!rawMsg.message || !rawMsg.key?.id) continue;
      if (processedIds.has(rawMsg.key.id)) continue;
      processedIds.add(rawMsg.key.id);
      setTimeout(() => processedIds.delete(rawMsg.key.id), 60_000);

      const jid = rawMsg.key.remoteJid;
      const content = unwrapMessage(rawMsg.message);
      if (!content) continue;

      const rawText =
        content?.videoMessage?.caption ||
        content?.imageMessage?.caption ||
        content?.extendedTextMessage?.text ||
        content?.conversation ||
        '';

      const cmd = rawText.trim().split(/\s+/)[0]?.toLowerCase();
      if (!['/sa', '/s', '/rhelp'].includes(cmd)) continue;

      if (cmd === '/rhelp') {
        const helpText = [
          '*PANDUAN BOT STIKER*',
          '',
          '*1. /s — Stiker Biasa (Tanpa Suara)*',
          '• Kirim foto atau video pendek dengan caption `/s`',
          '• Atau reply foto/video yang sudah terkirim pakai `/s`',
          '',
          '*2. /sa — Stiker Bersuara (Maks 10 Detik)*',
          '• Kirim video bersuara dengan caption `/sa`',
          '• Reply video bersuara pakai `/sa`',
          '• Kirim foto dengan caption `/sa` sambil reply VN/audio',
          '• Atau reply foto pakai VN/audio dengan caption `/sa`',
          '',
          '*3. /rhelp — Menampilkan panduan ini*',
          '',
          '_Catatan: Video lebih dari 10 detik otomatis dipotong ke 10 detik pertama._'
        ].join('\n');

        await sock.sendMessage(jid, { text: helpText }, { quoted: rawMsg });
        continue;
      }

      const quotedRaw = content?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quoted = unwrapMessage(quotedRaw);

      const msgHasVideo = Boolean(content?.videoMessage);
      const msgHasImage = Boolean(content?.imageMessage);
      const quotedHasVideo = Boolean(quoted?.videoMessage);
      const quotedHasImage = Boolean(quoted?.imageMessage);
      const quotedHasAudio = Boolean(quoted?.audioMessage);

      const id = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const visualInputPath = `./temp_vis_${id}`;
      const audioInputPath = `./temp_aud_${id}`;
      const outWebpPath = `./temp_out_${id}.webp`;
      const outOggPath = `./temp_out_${id}.ogg`;

      try {
        if (cmd === '/sa') {
          let visualMsgObj = null;
          let audioMsgObj = null;
          let isAnimated = false;

          if (msgHasVideo) {
            visualMsgObj = { message: content };
            audioMsgObj = { message: content };
            isAnimated = true;
          } else if (quotedHasVideo) {
            visualMsgObj = { message: quoted };
            audioMsgObj = { message: quoted };
            isAnimated = true;
          } else if (msgHasImage && quotedHasAudio) {
            visualMsgObj = { message: content };
            audioMsgObj = { message: quoted };
            isAnimated = false;
          } else if (quotedHasImage && content?.audioMessage) {
            visualMsgObj = { message: quoted };
            audioMsgObj = { message: content };
            isAnimated = false;
          } else {
            await sock.sendMessage(
              jid,
              {
                text: 'Format salah. Ketik `/rhelp` buat lihat panduan lengkap cara pakai `/sa`.'
              },
              { quoted: rawMsg }
            );
            continue;
          }

          const visBuffer = await downloadMediaMessage(visualMsgObj, 'buffer', {});
          fs.writeFileSync(visualInputPath, visBuffer);

          if (audioMsgObj === visualMsgObj) {
            fs.copyFileSync(visualInputPath, audioInputPath);
          } else {
            const audBuffer = await downloadMediaMessage(audioMsgObj, 'buffer', {});
            fs.writeFileSync(audioInputPath, audBuffer);
          }

          const rawDur = await getMediaDuration(audioInputPath);
          const isLong = rawDur > 5;

          const size = isLong ? 360 : 480;
          const quality = isLong ? 50 : 68;

          const vfFilter = isAnimated
            ? `fps=15,scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${size}:${size}:-1:-1:color=white@0.0`
            : `scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,pad=512:512:-1:-1:color=white@0.0`;

          await execAsync(
            `"${ffmpegPath}" -y -i "${visualInputPath}" -t ${MAX_DURATION} -vcodec libwebp -filter:v "${vfFilter}" -lossless 0 -compression_level 6 -q:v ${quality} -loop 0 -an -vsync 0 "${outWebpPath}"`
          );

          if (isAnimated && fs.statSync(outWebpPath).size > 850 * 1024) {
            await execAsync(
              `"${ffmpegPath}" -y -i "${visualInputPath}" -t ${MAX_DURATION} -vcodec libwebp -filter:v "fps=12,scale=300:300:force_original_aspect_ratio=decrease:flags=lanczos,pad=300:300:-1:-1:color=white@0.0" -lossless 0 -compression_level 6 -q:v 38 -loop 0 -an -vsync 0 "${outWebpPath}"`
            );
          }

          await execAsync(
            `"${ffmpegPath}" -y -i "${audioInputPath}" -t ${MAX_DURATION} -vn -c:a libopus -b:a 96k -ar 48000 -ac 1 "${outOggPath}"`
          );

          const finalDuration = await getMediaDuration(outOggPath);
          const audioSeconds = Math.max(1, Math.min(MAX_DURATION, Math.ceil(finalDuration)));
          const webpSizeKB = Math.round(fs.statSync(outWebpPath).size / 1024);

          console.log(
            `Proses /sa -> Asli: ${rawDur.toFixed(1)}s | Output: ${audioSeconds}s | Ukuran WebP: ${webpSizeKB} KB`
          );

          const stickerPrep = await prepareWAMessageMedia(
            { sticker: fs.readFileSync(outWebpPath) },
            { upload: sock.waUploadToServer }
          );

          const audioPrep = await prepareWAMessageMedia(
            {
              audio: fs.readFileSync(outOggPath),
              mimetype: 'audio/ogg; codecs=opus',
              ptt: false
            },
            { upload: sock.waUploadToServer }
          );

          audioPrep.audioMessage.seconds = audioSeconds;
          audioPrep.audioMessage.ptt = false;

          const stickerMessage = stickerPrep.stickerMessage;
          stickerMessage.isAnimated = isAnimated;
          stickerMessage.audioMessage = audioPrep.audioMessage;

          const payload = proto.Message.fromObject({
            audioStickerMessage: {
              message: {
                stickerMessage
              }
            }
          });

          const waMsg = generateWAMessageFromContent(jid, payload, {
            userJid: jidNormalizedUser(sock.user.id),
            quoted: rawMsg
          });

          await sock.relayMessage(jid, waMsg.message, {
            messageId: waMsg.key.id
          });
        } else if (cmd === '/s') {
          const targetMsg = quotedHasVideo || quotedHasImage ? { message: quoted } : { message: content };
          const hasMedia = Boolean(targetMsg.message?.videoMessage || targetMsg.message?.imageMessage);

          if (!hasMedia) {
            await sock.sendMessage(
              jid,
              { text: 'Kirim atau reply foto/video pendek pakai caption `/s` ya. Ketik `/rhelp` buat info lengkap.' },
              { quoted: rawMsg }
            );
            continue;
          }

          const visBuffer = await downloadMediaMessage(targetMsg, 'buffer', {});
          fs.writeFileSync(visualInputPath, visBuffer);

          await execAsync(
            `"${ffmpegPath}" -y -i "${visualInputPath}" -t ${MAX_DURATION} -vcodec libwebp -filter:v "fps=15,scale=420:420:force_original_aspect_ratio=decrease:flags=lanczos,pad=420:420:-1:-1:color=white@0.0" -lossless 0 -compression_level 6 -q:v 60 -loop 0 -an -vsync 0 "${outWebpPath}"`
          );

          await sock.sendMessage(
            jid,
            { sticker: fs.readFileSync(outWebpPath) },
            { quoted: rawMsg }
          );
        }
      } catch (err) {
        console.error('Gagal proses stiker:', err);
        await sock.sendMessage(
          jid,
          { text: 'Waduh, gagal bikin stikernya. Pastikan videonya punya suara dan formatnya didukung.' },
          { quoted: rawMsg }
        );
      } finally {
        [visualInputPath, audioInputPath, outWebpPath, outOggPath].forEach((file) => {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        });
      }
    }
  });
}

startBot();