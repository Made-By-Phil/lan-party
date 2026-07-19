import { networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";

/** Best-guess LAN IPv4 addresses, most likely candidates first. */
export function lanAddresses(): string[] {
  const addrs: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      addrs.push(iface.address);
    }
  }
  const score = (a: string) =>
    a.startsWith("192.168.") ? 0 : a.startsWith("10.") ? 1 : 2;
  return addrs.sort((a, b) => score(a) - score(b));
}

export function printBanner(port: number, gameNames: string[]): void {
  const addrs = lanAddresses();
  const url = addrs.length ? `http://${addrs[0]}:${port}` : `http://localhost:${port}`;
  console.log("");
  console.log("  🎉 LAN Party is on!");
  console.log("");
  console.log(`  Join from any device on this network:`);
  console.log(`  →  ${url}`);
  for (const a of addrs.slice(1)) console.log(`     http://${a}:${port}`);
  console.log(`     http://localhost:${port} (this machine)`);
  console.log("");
  console.log(`  Games: ${gameNames.length ? gameNames.join(", ") : "none found"}`);
  console.log("");
  if (addrs.length) {
    qrcode.generate(url, { small: true }, (code) => {
      console.log(code.replace(/^/gm, "  "));
    });
  }
}
