import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TraceStudio } from "./app/trace-studio.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Trace Studio root element is missing.");

createRoot(root).render(
  <StrictMode>
    <TraceStudio />
  </StrictMode>,
);
