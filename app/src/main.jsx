import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PollarProvider } from "@pollar/react";
import App from "./App.jsx";
import "./styles.css";

const pollarKey = import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY;
const pollarConfigured = Boolean(pollarKey) && pollarKey.startsWith("pub_testnet_");
const hasPollar = pollarConfigured && window.isSecureContext && Boolean(globalThis.crypto?.subtle);
const pollarNotice = pollarConfigured && !hasPollar
  ? "Google wallet login needs HTTPS or localhost. Paste a Stellar testnet address to join from this connection."
  : undefined;

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {hasPollar ? (
      <PollarProvider client={{ apiKey: pollarKey, stellarNetwork: "testnet" }}>
        <App pollar pollarNotice={pollarNotice} />
      </PollarProvider>
    ) : (
      <App pollar={false} pollarNotice={pollarNotice} />
    )}
  </StrictMode>,
);
