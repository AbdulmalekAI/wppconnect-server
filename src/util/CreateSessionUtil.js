import { clientsArray, IP_BASE, sessions } from "./SessionUtil";
import { create, SocketState } from "@wppconnect-team/wppconnect";
import fs from "fs";
import path from "path";
import api from 'axios'

let chromiumArgs = ['--disable-web-security', '--no-sandbox', '--disable-web-security', '--aggressive-cache-discard', '--disable-cache', '--disable-application-cache', '--disable-offline-load-stale-cache', '--disk-cache-size=0', '--disable-background-networking', '--disable-default-apps', '--disable-extensions', '--disable-sync', '--disable-translate', '--hide-scrollbars', '--metrics-recording-only', '--mute-audio', '--no-first-run', '--safebrowsing-disable-auto-update', '--ignore-certificate-errors', '--ignore-ssl-errors', '--ignore-certificate-errors-spki-list'];

export async function opendata(req, session) {
    await createSessionUtil(req, clientsArray, session)
}

async function createSessionUtil(req, clientsArray, session) {
    try {
        clientsArray[session] = await create(session, (base64Qr, asciiQR) => {
            exportQR(req, base64Qr, session);
        }, (statusFind) => {
            console.log(statusFind + '\n\n')
        }, {
            headless: true,
            devtools: false,
            useChrome: true,
            debug: false,
            logQR: true,
            browserArgs: chromiumArgs,
            refreshQR: 15000,
            disableSpins: true,
        })

        //ele nem vem pra cá
        console.log('entrando no start ->')
        await start(req, clientsArray, session);
    } catch (e) {
        console.log('error create -> ', e)
    }
}

function exportQR(req, qrCode, session) {
    qrCode = qrCode.replace('data:image/png;base64,', '');
    const imageBuffer = Buffer.from(qrCode, 'base64');

    fs.writeFileSync(`${session}.png`, imageBuffer);

    req.io.emit('qrCode', {
        data: 'data:image/png;base64,' + imageBuffer.toString('base64'),
        session: session
    });
}

async function start(req, client, session) {
    await checkStateSession(client, session)

    await listenMessages(req, client, session)
    await listenAcks(client, session)
}

async function checkStateSession(client, session) {
    await client[session].onStateChange((state) => {
        const conflits = [
            SocketState.CONFLICT,
            SocketState.UNPAIRED,
            SocketState.UNLAUNCHED,
        ];

        if (conflits.includes(state)) {
            client[session].useHere();
        }
    });
}

const downloadFiles = async (client, message) => {
    if (message && (message.isMedia || message.isMMS)) {
        let buffer = await client.decryptFile(message);
        message.mediaData['mediaBlob'] = await buffer.toString('base64');
    }
}

async function listenMessages(req, client, session) {
    await client[session].onMessage(async (message) => {
        await downloadFiles(client, message)

        await api.post(IP_BASE, { message: message })
    })

    await client[session].onAnyMessage((message) => {
        message.session = session
        req.io.emit('received-message', { response: message })
    });
}

async function listenAcks(client, session) {
    // Listen to ack's
    // See the status of the message when sent.
    // When receiving the confirmation object, "ack" may return a number, look {@link AckType} for details:
    // -7 = MD_DOWNGRADE,
    // -6 = INACTIVE,
    // -5 = CONTENT_UNUPLOADABLE,
    // -4 = CONTENT_TOO_BIG,
    // -3 = CONTENT_GONE,
    // -2 = EXPIRED,
    // -1 = FAILED,
    //  0 = CLOCK,
    //  1 = SENT,
    //  2 = RECEIVED,
    //  3 = READ,
    //  4 = PLAYED
    await client[session].onAck(async (ack) => {
        await api.post(IP_BASE, { ack: ack })
    });

}