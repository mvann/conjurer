import Head from "next/head";
import dynamic from "next/dynamic";
import { Cormorant_Garamond } from "next/font/google";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mystical",
});

// The editor renders a WebGL canvas; keep it client-only.
const EditorV2Page = dynamic(
  () =>
    import("@/src/components/EditorV2/EditorV2Page").then(
      (module) => module.EditorV2Page,
    ),
  { ssr: false },
);

export default function Editor() {
  return (
    <>
      <Head>
        <title>Conjurer — Spell Crafter</title>
      </Head>
      <div className={cormorantGaramond.variable}>
        <EditorV2Page />
      </div>
    </>
  );
}
