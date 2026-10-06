import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { registerBuiltinContributions } from "./bootstrap/registerBuiltinContributions";
import "./i18n";
import "./fonts.css";
import "./styles.css";

const queryClient = new QueryClient();
registerBuiltinContributions();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
