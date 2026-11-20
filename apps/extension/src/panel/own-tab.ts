
import { tabIdFromSearch } from "../shared/panel-path";

export function ownTabId(): number | null {
  return tabIdFromSearch(typeof location === "undefined" ? "" : location.search);
}
