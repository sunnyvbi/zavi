import { ApiFetchError, apiJson } from "../../lib/api";

export type DeleteAccountResult = {
  deleted_user_id: string;
  deleted_tenants: string[];
  left_tenants: string[];
};

export class AccountDeletionUnavailableError extends Error {
  constructor() {
    super("Account deletion is not available on this server yet.");
    this.name = "AccountDeletionUnavailableError";
  }
}

export async function deleteAccount(): Promise<DeleteAccountResult> {
  try {
    return await apiJson<DeleteAccountResult>("/api/account", {
      method: "DELETE",
      body: JSON.stringify({ source: "mobile" }),
    });
  } catch (e) {
    if (
      e instanceof ApiFetchError &&
      e.code.startsWith("http_") &&
      (e.status === 404 || e.status === 405 || e.status === 501)
    ) {
      throw new AccountDeletionUnavailableError();
    }
    throw e;
  }
}
