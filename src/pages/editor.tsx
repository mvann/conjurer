import Head from "next/head";
import dynamic from "next/dynamic";
import { Cormorant_Garamond } from "next/font/google";
import { useMemo } from "react";
import { ChakraProvider, theme } from "@chakra-ui/react";
import { Store } from "@/src/types/Store";
import { StoreContext } from "@/src/types/StoreContext";

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
  // The spell crafter is an experience editor: it shares the main
  // app's store, load pipeline, and persistence wholesale. Only the
  // UI in front of that store is its own.
  const store = useMemo(() => new Store("experienceEditor"), []);
  return (
    <>
      <Head>
        <title>Conjurer — Spell Crafter</title>
      </Head>
      <StoreContext.Provider value={store}>
        {/* Chakra hosts the shared modals (save-as, open, user picker)
            and toasts; resetCSS stays off so the spell crafter's own
            styling is untouched. */}
        <ChakraProvider theme={theme} resetCSS={false}>
          <div className={cormorantGaramond.variable}>
            <EditorV2Page />
          </div>
        </ChakraProvider>
      </StoreContext.Provider>
    </>
  );
}
