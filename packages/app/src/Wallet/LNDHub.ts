import { EventPublisher } from "Feed/EventPublisher";
import {
  InvoiceRequest,
  LNWallet,
  prToWalletInvoice,
  Sats,
  WalletError,
  WalletErrorCode,
  WalletInfo,
  WalletInvoice,
  WalletInvoiceState,
} from "Wallet";

const defaultHeaders = {
  Accept: "application/json",
  "Content-Type": "application/json",
};

export default class LNDHubWallet implements LNWallet {
  type: "lndhub" | "snort";
  url: string;
  user: string;
  password: string;
  auth?: AuthResponse;
  publisher?: EventPublisher;

  constructor(url: string, publisher?: EventPublisher) {
    if (url.startsWith("lndhub://")) {
      const regex = /^lndhub:\/\/([\S-]+):([\S-]+)@(.*)$/i;
      const parsedUrl = url.match(regex);
      console.debug(parsedUrl);
      if (!parsedUrl || parsedUrl.length !== 4) {
        throw new Error("Invalid LNDHUB config");
      }
      this.url = new URL(parsedUrl[3]).toString();
      this.user = parsedUrl[1];
      this.password = parsedUrl[2];
      this.type = "lndhub";
    } else if (url.startsWith("snort://")) {
      const u = new URL(url);
      this.url = `https://${u.host}${u.pathname}`;
      this.user = "";
      this.password = "";
      this.type = "snort";
      this.publisher = publisher;
    } else {
      throw new Error("Invalid config");
    }
  }

  isReady(): boolean {
    return this.auth !== undefined;
  }

  close(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async getInfo() {
    return await this.getJson<WalletInfo>("GET", "/getinfo");
  }

  async login() {
    if (this.type === "snort") return true;

    const rsp = await this.getJson<AuthResponse>("POST", "/auth?type=auth", {
      login: this.user,
      password: this.password,
    });
    this.auth = rsp as AuthResponse;
    return true;
  }

  async getBalance(): Promise<Sats> {
    const rsp = await this.getJson<GetBalanceResponse>("GET", "/balance");
    const bal = Math.floor((rsp as GetBalanceResponse).BTC.AvailableBalance);
    return bal as Sats;
  }

  async createInvoice(req: InvoiceRequest) {
    const rsp = await this.getJson<UserInvoicesResponse>("POST", "/addinvoice", {
      amt: req.amount,
      memo: req.memo,
    });

    const pRsp = rsp as UserInvoicesResponse;
    return {
      pr: pRsp.payment_request,
      memo: req.memo,
      amount: req.amount,
      paymentHash: pRsp.payment_hash,
      timestamp: pRsp.timestamp,
    } as WalletInvoice;
  }

  async payInvoice(pr: string) {
    const rsp = await this.getJson<PayInvoiceResponse>("POST", "/payinvoice", {
      invoice: pr,
    });

    const pRsp = rsp as PayInvoiceResponse;
    return {
      pr: pr,
      paymentHash: pRsp.payment_hash,
      state: pRsp.payment_error === undefined ? WalletInvoiceState.Paid : WalletInvoiceState.Pending,
    } as WalletInvoice;
  }

  async getInvoices(): Promise<WalletInvoice[]> {
    const rsp = await this.getJson<UserInvoicesResponse[]>("GET", "/getuserinvoices");
    return (rsp as UserInvoicesResponse[]).map(a => {
      const decodedInvoice = prToWalletInvoice(a.payment_request);
      if (!decodedInvoice) {
        throw new WalletError(WalletErrorCode.InvalidInvoice, "Failed to parse invoice");
      }
      return {
        ...decodedInvoice,
        state: a.ispaid ? WalletInvoiceState.Paid : decodedInvoice.state,
        paymentHash: a.payment_hash,
        memo: a.description,
      } as WalletInvoice;
    });
  }

  private async getJson<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let auth = `Bearer ${this.auth?.access_token}`;
    if (this.type === "snort") {
      const ev = await this.publisher?.generic(`${new URL(this.url).pathname}${path}`, 30_000);
      auth = JSON.stringify(ev?.ToObject());
    }
    const rsp = await fetch(`${this.url}${path}`, {
      method: method,
      body: body ? JSON.stringify(body) : undefined,
      headers: {
        ...defaultHeaders,
        Authorization: auth,
      },
    });
    const json = await rsp.json();
    if ("error" in json) {
      const err = json as ErrorResponse;
      throw new WalletError(err.code, err.message);
    }
    return json as T;
  }
}

interface AuthResponse {
  refresh_token?: string;
  access_token?: string;
  token_type?: string;
}

interface GetBalanceResponse {
  BTC: {
    AvailableBalance: number;
  };
}

interface UserInvoicesResponse {
  amt: number;
  description: string;
  ispaid: boolean;
  type: string;
  timestamp: number;
  pay_req: string;
  payment_hash: string;
  payment_request: string;
  r_hash: string;
}

interface PayInvoiceResponse {
  payment_error?: string;
  payment_hash: string;
  payment_preimage: string;
  payment_route?: { total_amt: number; total_fees: number };
}

interface ErrorResponse {
  code: number;
  message: string;
}
