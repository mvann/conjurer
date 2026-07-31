import { useEffect, useState } from "react";
import { action, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { FaUser } from "react-icons/fa";
import styles from "@/styles/EditorV2.module.css";
import { useStore } from "@/src/types/StoreContext";
import { trpc } from "@/src/utils/trpc";
import { sanitize } from "@/src/utils/sanitize";
import { CONJURER_USER } from "@/src/types/User";

// Spell Crafter's log in: the same behaviour as the main app's LoginButton —
// list the users, pick one, or make a name — drawn as a panel sliding in from
// the RIGHT in the chrome's own dark-glass style, like the songs panel, rather
// than as a raw Chakra modal that would clash with everything else here.
//
// "Log in" is the main app's own wording (`userStore.username || "Log in"`), so
// the two apps say the same thing.
//
// Saving an experience writes a row with an owner, and upstream's serialize
// refuses without a user — so an unsigned-in editor cannot save at all. The
// panel therefore opens itself when nobody is signed in, rather than letting
// someone build something they will be told they cannot keep.

export const EditorLoginPanel = observer(function EditorLoginPanel() {
  const store = useStore();
  const { uiStore, userStore, usingLocalData } = store;
  const [newUsername, setNewUsername] = useState("");

  const isOpen = uiStore.showingUserPickerModal;

  const { isPending, isError, refetch, data: users } =
    trpc.user.listUsers.useQuery(
      { usingLocalData },
      { enabled: isOpen, retry: 1 },
    );
  const createUser = trpc.user.createUser.useMutation();

  // Stale localStorage can point at the prod DB with no credentials configured;
  // fall back to local data rather than showing an empty list forever.
  useEffect(() => {
    if (
      !isError ||
      usingLocalData ||
      process.env.NEXT_PUBLIC_NODE_ENV === "production"
    )
      return;
    runInAction(() => {
      store.usingLocalData = true;
    });
  }, [isError, usingLocalData, store]);

  // Nobody signed in means nothing can be saved, so ask straight away.
  useEffect(() => {
    if (store.initializationState !== "initialized") return;
    if (userStore.me) return;
    runInAction(() => {
      uiStore.showingUserPickerModal = true;
    });
  }, [store.initializationState, userStore.me, uiStore]);

  const close = action(() => {
    // Closing without a user would leave the editor unable to save; the panel
    // stays until someone is signed in.
    if (!userStore.me) return;
    uiStore.showingUserPickerModal = false;
    setNewUsername("");
  });

  const pick = action((user: Parameters<typeof userStore.setMe>[0]) => {
    userStore.setMe(user);
    uiStore.showingUserPickerModal = false;
    setNewUsername("");
  });

  const createDisabled =
    !newUsername ||
    users?.some((user) => user.username === newUsername) ||
    newUsername === CONJURER_USER.username;

  return (
    <>
      {isOpen && (
        <div className={styles.panelBackdrop} onClick={close} />
      )}
      <aside
        className={`${styles.sidePanel} ${styles.songsPanel} ${
          isOpen ? styles.songsPanelOpen : ""
        }`}
        data-doc="login-panel"
        aria-hidden={!isOpen}
      >
        <div className={styles.panelColumn}>
          <div className={styles.panelSectionLabel}>Log in</div>

          {isPending && <div className={styles.panelEmpty}>Loading…</div>}
          {isError && (
            <div className={styles.panelEmpty}>
              <button className={styles.effectPickerItem} onClick={() => refetch()}>
                Could not reach the server. Retry
              </button>
            </div>
          )}
          {!isPending && !isError && !users?.length && (
            <div className={styles.panelEmpty}>No users yet</div>
          )}

          <ul className={styles.userList}>
            {users?.map((user) => (
              <li key={user.id}>
                <button
                  className={styles.userItem}
                  onClick={() => pick(user)}
                  aria-label={`Log in as ${user.username}`}
                >
                  <FaUser size={10} />
                  <span className={styles.userName}>{user.username}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className={styles.panelSectionLabel}>New user</div>
          <div className={styles.newUserRow}>
            <input
              className={styles.uploadInput}
              value={newUsername}
              aria-label="New user name"
              placeholder="name"
              onChange={(event) => setNewUsername(sanitize(event.target.value))}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || createDisabled) return;
                event.preventDefault();
                void (async () => {
                  const created = await createUser.mutateAsync({
                    usingLocalData,
                    username: newUsername,
                  });
                  pick(created);
                })();
              }}
            />
            <button
              className={styles.createUserButton}
              disabled={createDisabled || createUser.isPending}
              onClick={async () => {
                const created = await createUser.mutateAsync({
                  usingLocalData,
                  username: newUsername,
                });
                pick(created);
              }}
            >
              {createUser.isPending ? "…" : "Create"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
});

// The header control: shows who is signed in, and reopens the panel.
export const EditorLoginButton = observer(function EditorLoginButton() {
  const store = useStore();
  const { uiStore, userStore } = store;
  return (
    <button
      className={styles.loginButton}
      data-doc="login"
      onClick={action(() => (uiStore.showingUserPickerModal = true))}
    >
      <FaUser size={11} />
      {userStore.username || "Log in"}
    </button>
  );
});
