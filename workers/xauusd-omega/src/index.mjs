// xauusd-omega Worker entry (omega.cryptophys.work). The logic and its documentation are in omega.mjs.
import { handle } from "./omega.mjs";

export default {
  async fetch(request, env) {
    return handle(request, env);
  }
};
