import { Whatsapp } from '@wppconnect-team/wppconnect';

export interface WhatsAppServer extends Whatsapp {
  config: any;
  urlcode: string;
  status: string;
}
