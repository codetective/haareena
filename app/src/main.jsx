import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PollarProvider } from "@pollar/react";
import App from "./App.jsx";
import "./styles.css";

const pollarKey = import.meta.env.VITE_POLLAR_PUBLISHABLE_KEY;
const hasPollar = Boolean(pollarKey) && pollarKey.startsWith("pub_testnet_");

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {hasPollar ? (
      <PollarProvider client={{ apiKey: pollarKey, stellarNetwork: "testnet" }}>
        <App pollar />
      </PollarProvider>
    ) : (
      <App pollar={false} />
    )}
  </StrictMode>,
);
