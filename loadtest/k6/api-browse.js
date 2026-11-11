// API load test: authenticated browsing (list library, open a video) at a constant
// arrival rate. Run: make load  (RATE=50 DURATION=2m by default)
import { check } from "k6";
import { api, login } from "./lib.js";

const RATE = Number(__ENV.RATE || 50);

export const options = {
  scenarios: {
    browse: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: __ENV.DURATION || "2m",
      preAllocatedVUs: 20,
      maxVUs: 200,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:list}": ["p(95)<300"],
    "http_req_duration{endpoint:detail}": ["p(95)<300"],
    dropped_iterations: ["rate<" + RATE * 0.01], // kept up with at least 99% of the offered rate
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

export function setup() {
  const cookie = login();
  const items = api("GET", "/videos", cookie).json("items");
  return { cookie, ids: items.map((v) => v.id) };
}

export default function ({ cookie, ids }) {
  // 1 in 3 iterations opens a video page; the rest list the library
  if (ids.length && __ITER % 3 === 0) {
    const r = api("GET", `/videos/${ids[__ITER % ids.length]}`, cookie, null, { endpoint: "detail" });
    check(r, { "detail 200": (x) => x.status === 200 });
  } else {
    const r = api("GET", "/videos", cookie, null, { endpoint: "list" });
    check(r, { "list 200": (x) => x.status === 200 });
  }
}
