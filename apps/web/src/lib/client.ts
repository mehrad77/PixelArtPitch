// Picks the backend: the mock when the URL has ?mock=1 (remembered for the tab) or VITE_PAP_MOCK=1, else HTTP.
// ?mock=0 turns a remembered mock off.
import { MockClient } from "../mock/client.ts";
import { HttpClient } from "./api.ts";
import type { Client } from "./types.ts";

function wantMock(): boolean {
  const q = new URLSearchParams(location.search).get("mock");
  try {
    if (q === "1") sessionStorage.setItem("pap-mock", "1");
    if (q === "0") sessionStorage.removeItem("pap-mock");
    if (sessionStorage.getItem("pap-mock") === "1") return true;
  } catch {
    if (q === "1") return true;
  }
  return import.meta.env.VITE_PAP_MOCK === "1";
}

export const client: Client = wantMock() ? new MockClient() : new HttpClient();
