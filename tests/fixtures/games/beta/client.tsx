import type { GameClientProps } from "lan-party/sdk";

export default function Client({ game }: GameClientProps) {
  return <div className="fx-root">{String((game.state as { label?: string })?.label ?? "beta")}</div>;
}
