/*
 * Copyright 2021 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// import 'dotenv-import';

import { create, SocketState } from '@wppconnect-team/wppconnect';
import axios from 'axios';
import { Request } from 'express';

// import config from '../config';
import { download } from '../controller/sessionController';
import { WhatsAppServer } from '../types/WhatsAppServer';
import chatWootClient from './chatWootClient';
import { autoDownload, callWebHook, startHelper } from './functions';
import { clientsArray, eventEmitter } from './sessionUtil';
import Factory from './tokenStore/factory';

export default class CreateSessionUtil {
  startChatWootClient(client: any) {
    if (client.config.chatWoot && !client._chatWootClient)
      client._chatWootClient = new chatWootClient(
        client.config.chatWoot,
        client.session
      );
    return client._chatWootClient;
  }

  async createSessionUtil(
    req: any,
    clientsArray: any,
    session: string,
    res?: any
  ) {
    try {
      let client = this.getClient(session) as any;
      if (client.status != null && client.status !== 'CLOSED') return;
      client.status = 'INITIALIZING';
      client.config = req.body;

      const tokenStore = new Factory();
      const myTokenStore = tokenStore.createTokenStory(client);
      const tokenData = await myTokenStore.getToken(session);

      if (!tokenData) {
        myTokenStore.setToken(session, {});
      }

      this.startChatWootClient(client);

      if (req.serverOptions.customUserDataDir) {
        req.serverOptions.createOptions.puppeteerOptions = {
          userDataDir: req.serverOptions.customUserDataDir + session,
        };
      }

      const wppClient = await create(
        Object.assign(
          {},
          { tokenStore: myTokenStore },
          req.serverOptions.createOptions,
          {
            session: session,
            deviceName:
              client.config?.deviceName || req.serverOptions.deviceName,
            poweredBy:
              client.config?.poweredBy ||
              req.serverOptions.poweredBy ||
              'WPPConnect-Server',
            catchQR: (
              base64Qr: any,
              asciiQR: any,
              attempt: any,
              urlCode: string
            ) => {
              this.exportQR(req, base64Qr, urlCode, client, res);
            },
            onLoadingScreen: (percent: string, message: string) => {
              req.logger.info(`[${session}] ${percent}% - ${message}`);
            },
            statusFind: (statusFind: string) => {
              try {
                eventEmitter.emit(
                  `status-${client.session}`,
                  client,
                  statusFind
                );
                if (
                  statusFind === 'autocloseCalled' ||
                  statusFind === 'desconnectedMobile'
                ) {
                  client.status = 'CLOSED';
                  client.qrcode = null;
                  client.close();
                  clientsArray[session] = undefined;
                }
                callWebHook(client, req, 'status-find', {
                  status: statusFind,
                  session: client.session,
                });
                req.logger.info(statusFind + '\n\n');
              } catch (error) {}
            },
          }
        )
      );

      client = clientsArray[session] = Object.assign(wppClient, client);
      await this.start(req, client);

      if (req.serverOptions.webhook.onParticipantsChanged) {
        await this.onParticipantsChanged(req, client);
      }

      if (req.serverOptions.webhook.onReactionMessage) {
        await this.onReactionMessage(client, req);
      }

      if (req.serverOptions.webhook.onRevokedMessage) {
        await this.onRevokedMessage(client, req);
      }

      if (req.serverOptions.webhook.onPollResponse) {
        await this.onPollResponse(client, req);
      }
      if (req.serverOptions.webhook.onLabelUpdated) {
        await this.onLabelUpdated(client, req);
      }
    } catch (e) {
      req.logger.error(e);
    }
  }

  async opendata(req: Request, session: string, res?: any) {
    await this.createSessionUtil(req, clientsArray, session, res);
  }

  exportQR(
    req: any,
    qrCode: any,
    urlCode: any,
    client: WhatsAppServer,
    res?: any
  ) {
    eventEmitter.emit(`qrcode-${client.session}`, qrCode, urlCode, client);
    Object.assign(client, {
      status: 'QRCODE',
      qrcode: qrCode,
      urlcode: urlCode,
    });

    qrCode = qrCode.replace('data:image/png;base64,', '');
    const imageBuffer = Buffer.from(qrCode, 'base64');

    req.io.emit('qrCode', {
      data: 'data:image/png;base64,' + imageBuffer.toString('base64'),
      session: client.session,
    });

    callWebHook(client, req, 'qrcode', {
      qrcode: qrCode,
      urlcode: urlCode,
      session: client.session,
    });
    if (res && !res._headerSent)
      res.status(200).json({
        status: 'qrcode',
        qrcode: qrCode,
        urlcode: urlCode,
        session: client.session,
      });
  }

  async onParticipantsChanged(req: any, client: any) {
    await client.isConnected();
    await client.onParticipantsChanged((message: any) => {
      callWebHook(client, req, 'onparticipantschanged', message);
    });
  }

  async start(req: Request, client: WhatsAppServer) {
    try {
      await client.isConnected();
      Object.assign(client, { status: 'CONNECTED', qrcode: null });

      req.logger.info(`Started Session: ${client.session}`);
      //callWebHook(client, req, 'session-logged', { status: 'CONNECTED'});
      req.io.emit('session-logged', { status: true, session: client.session });
      startHelper(client, req);
    } catch (error) {
      req.logger.error(error);
      req.io.emit('session-error', client.session);
    }

    await this.checkStateSession(client, req);
    await this.listenMessages(client, req);

    if (req.serverOptions.webhook.listenAcks) {
      await this.listenAcks(client, req);
    }

    if (req.serverOptions.webhook.onPresenceChanged) {
      await this.onPresenceChanged(client, req);
    }
  }

  async checkStateSession(client: WhatsAppServer, req: Request) {
    await client.onStateChange((state) => {
      req.logger.info(`State Change ${state}: ${client.session}`);
      const conflits = [SocketState.CONFLICT];

      if (conflits.includes(state)) {
        client.useHere();
      }
    });
  }

  async listenMessages(client: WhatsAppServer, req: Request) {
    await client.onMessage(async (message: any) => {
      eventEmitter.emit(`mensagem-${client.session}`, client, message);
      callWebHook(client, req, 'onmessage', message);
      console.log('this message is from  ' + message.from + '  story');
      console.log('this message is   ' + message.body);
      try {
        // await client.sendText(message.from, 'hello nosaaai');
        console.log(req.serverOptions.EMAIL);
        const jwtToken = req.serverOptions.jwk_token;
        console.log('refreshtoken is :' + jwtToken);
        const response = await callBotpressApi(message, jwtToken);

        if (response && response.status === 200) {
          await processAndSendResponses(client, message, response);
        } else {
          refreshToken();
        }
      } catch (error) {
        console.error('Error when sending text: ', error);
      }

      if (message.type === 'location')
        client.onLiveLocation(message.sender.id, (location) => {
          callWebHook(client, req, 'location', location);
        });
    });
    // Function to refresh JWT
    async function refreshToken() {
      const loginData = {
        email: req.serverOptions.EMAIL,
        password: req.serverOptions.PASSWORD,
      };
      const loginUrl =
        req.serverOptions.BOT_URL + '/api/v1/auth/login/basic/default';
      console.log(
        'uuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu' + JSON.stringify(loginData)
      );console.log(
        'uuuuuuuuuuuuloginUrluuuuuuuuuuuuuuuuuuuu' + JSON.stringify(loginUrl)
      );
      const headers = {
        'Content-Type': 'application/json',
      };
      setTimeout(() => {
        axios
          .post(loginUrl, loginData, { headers })
          .then((response) => {
            console.log(
              'Login ddddddddddddddddddddddddddddddddddd successfulthe respose is :',
              response
            );
            const jwtToken1 = response.data.payload.jwt;
            req.serverOptions.jwk_token = jwtToken1;
            return jwtToken1;
          })
          .catch((error) => {
            console.error(
              'Error eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeelogging in:',
              error.response.data
            );
            return { status: false, message: error.message };
          });
      }, 2000);
      // try {
      //   console.log('dddddddddddddddddddddddddddddddddddddddddddddddddd');
      //   const response = await axios.post(loginUrl, loginData, { headers });
      //   // const responseJwt: AxiosResponse = await axios(config);
      //   console.log('refreshToken the response status is :' + response.status);
      //   const jwtToken1 = response.data.payload.jwt;
      //   return jwtToken1;
      // } catch (error) {
      //   if (error.response) {
      //     console.log('Error logging in:', error.response.data);
      //     return error.response.data;
      //   } else {
      //     console.log('Unexpected error:', error.message);
      //     return error.message;
      //   }
      // }
    }

    // 111 defining fuction to send message to botpress and get the response as respnseBot
    async function callBotpressApi(msg, jwtToken) {
      try {
        const phone = msg.from;
        const phoneid = phone.replace('967', '').replace('@c.us', '');
        const botId = req.serverOptions.BOT_ID;
        const userId = phoneid;
        const include = 'nlu,state,suggestions,decision';
        //   const token = token;
        const url =
          req.serverOptions.BOT_URL +
          `/api/v1/bots/${botId}/converse/${userId}/secured?include=${include}`;
        const headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwtToken}`,
        };
        const data = {
          type: 'text',
          text: msg.body,
        };
        const respnseBot = await axios.post(url, data, { headers });
        return respnseBot; // Return the API response data
      } catch (error) {
        let errorMessage = 'Failed to do something exceptional';
        if (error instanceof Error) {
          errorMessage = error.message;
        }
        console.log(errorMessage);
      }
    }
    // .111

    // Assuming `responseBot` is the response from Botpress with status 200
    async function processAndSendResponses(client, message, responseBot) {
      for (const response of responseBot.data.responses) {
        console.log(
          'the type to respnseBot.data.responses.type is:',
          response.type
        );
        console.log('the response is :', response);

        // Handle text responses
        if (response.type === 'text') {
          console.log('Handling text response');
          const messageText = response.text;
          try {
            await client.sendText(message.from, messageText);
            console.log('Text message sent successfully');
          } catch (error) {
            console.error('Error when sending text: ', error);
          }
        }

        // Handle single-choice (list) responses
        else if (response.type === 'single-choice') {
          console.log('Handling single-choice response');
          const listChoices = response.choices;
          const description = response.text;
          console.log('The listChoices is:', listChoices);

          const rows = listChoices.map((choice, index) => ({
            rowId: index.toString(),
            title: choice.title,
            description: choice.description,
          }));

          try {
            await client.sendListMessage(message.from, {
              buttonText: 'Click here to show the list',
              description: description,
              sections: [
                {
                  title: 'Available operations',
                  rows: rows,
                },
              ],
            });
            console.log('List message sent successfully');
          } catch (error) {
            console.error('Error when sending list: ', error);
          }
        } else if (response.type === 'file') {
          await client
            .sendFile(
              'message.from',
              '/home/abdo/Downloads/DoD.pdf',
              'file_name',
              'See my file in pdf'
            )
            .then((result) => {
              console.log('Result: ', result); //return object success
            })
            .catch((erro) => {
              console.error('Error when sending: ', erro); //return object error
            });
        }
      }
    }

    await client.onAnyMessage(async (message: any) => {
      message.session = client.session;

      if (message.type === 'sticker') {
        download(message, client, req.logger);
      }

      if (
        req.serverOptions?.websocket?.autoDownload ||
        (req.serverOptions?.webhook?.autoDownload && message.fromMe == false)
      ) {
        await autoDownload(client, req, message);
      }

      req.io.emit('received-message', { response: message });
      if (req.serverOptions.webhook.onSelfMessage && message.fromMe)
        callWebHook(client, req, 'onselfmessage', message);
    });

    await client.onIncomingCall(async (call) => {
      req.io.emit('incomingcall', call);
      callWebHook(client, req, 'incomingcall', call);
    });
  }

  async listenAcks(client: WhatsAppServer, req: Request) {
    await client.onAck(async (ack) => {
      req.io.emit('onack', ack);
      callWebHook(client, req, 'onack', ack);
    });
  }

  async onPresenceChanged(client: WhatsAppServer, req: Request) {
    await client.onPresenceChanged(async (presenceChangedEvent) => {
      req.io.emit('onpresencechanged', presenceChangedEvent);
      callWebHook(client, req, 'onpresencechanged', presenceChangedEvent);
    });
  }

  async onReactionMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onReactionMessage(async (reaction: any) => {
      req.io.emit('onreactionmessage', reaction);
      callWebHook(client, req, 'onreactionmessage', reaction);
    });
  }

  async onRevokedMessage(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onRevokedMessage(async (response: any) => {
      req.io.emit('onrevokedmessage', response);
      callWebHook(client, req, 'onrevokedmessage', response);
    });
  }
  async onPollResponse(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onPollResponse(async (response: any) => {
      req.io.emit('onpollresponse', response);
      callWebHook(client, req, 'onpollresponse', response);
    });
  }
  async onLabelUpdated(client: WhatsAppServer, req: Request) {
    await client.isConnected();
    await client.onUpdateLabel(async (response: any) => {
      req.io.emit('onupdatelabel', response);
      callWebHook(client, req, 'onupdatelabel', response);
    });
  }

  encodeFunction(data: any, webhook: any) {
    data.webhook = webhook;
    return JSON.stringify(data);
  }

  decodeFunction(text: any, client: any) {
    const object = JSON.parse(text);
    if (object.webhook && !client.webhook) client.webhook = object.webhook;
    delete object.webhook;
    return object;
  }

  getClient(session: any) {
    let client = clientsArray[session];

    if (!client)
      client = clientsArray[session] = {
        status: null,
        session: session,
      } as any;
    return client;
  }
}
