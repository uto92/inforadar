import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/700.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { createRoot } from "react-dom/client";
import App from "./App";

// StrictModeは意図的に外している: 開発時の二重マウントでカメラ
// (html5-qrcode) の起動/停止が競合するため。
createRoot(document.getElementById("root")!).render(<App />);
