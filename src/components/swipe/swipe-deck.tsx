"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "framer-motion";
import { ArrowUp, Heart, Laugh, Undo2, X } from "lucide-react";
import {
  deleteSaveAction,
  insertSaveAction,
  toggleCaptionVoteAction,
} from "@/app/actions/captions";
import type { SwipeCaption } from "@/app/actions/captions/fetch-swipe-deck-action";
import { useToast } from "@/hooks/use-toast";

// A vote sends a caption left (not funny) or right (funny).
type VoteDir = "left" | "right";
// Cards can also exit upward when skipped.
type ExitDir = VoteDir | "up";
// Anything that can land in history and be reversed with "go back".
type HistoryAction = VoteDir | "skip";

type HistoryEntry = {
  card: SwipeCaption;
  action: HistoryAction;
  // Only votes hit the server; skips have no request to await/undo.
  request?: Promise<unknown>;
};

const SWIPE_DISTANCE = 100;
const SWIPE_VELOCITY = 400;
const DOUBLE_TAP_MS = 300;
// Two-finger trackpad swipe: how much travel before it counts.
const WHEEL_THRESHOLD = 60;
// A pause longer than this between wheel events means fingers lifted, so the
// next event begins a fresh gesture that is allowed to fire again.
const WHEEL_GAP_MS = 140;

const exitVariants = {
  exit: (direction: ExitDir) => ({
    x: direction === "right" ? 1200 : direction === "left" ? -1200 : 0,
    y: direction === "up" ? -1200 : 0,
    opacity: 0,
    transition: { duration: 0.35, ease: "easeIn" as const },
  }),
};

const voteValue = (direction: VoteDir): 1 | -1 =>
  direction === "right" ? 1 : -1;

export default function SwipeDeck({
  initialDeck,
}: {
  initialDeck: SwipeCaption[];
}) {
  const [deck, setDeck] = useState<SwipeCaption[]>(initialDeck);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [exitDirection, setExitDirection] = useState<ExitDir>("right");
  const [heartBurstId, setHeartBurstId] = useState<string | null>(null);
  const { toast } = useToast();

  const topCard = deck[0];

  const swipe = useCallback(
    (direction: VoteDir) => {
      const card = deck[0];
      if (!card) return;

      setExitDirection(direction);
      setDeck((prev) => prev.slice(1));

      const request = toggleCaptionVoteAction(
        card.id,
        voteValue(direction)
      ).catch((error) => {
        console.error("Vote failed:", error);
        toast({
          title: "Your vote didn't save",
          description: "Check your connection and try again.",
          variant: "destructive",
        });
      });

      setHistory((prev) => [...prev, { card, action: direction, request }]);
    },
    [deck, toast]
  );

  // Skip: move past the current caption without voting on it. Recorded in
  // history so "go back" can bring it straight back.
  const skip = useCallback(() => {
    const card = deck[0];
    if (!card) return;

    setExitDirection("up");
    setDeck((prev) => prev.slice(1));
    setHistory((prev) => [...prev, { card, action: "skip" }]);
  }, [deck]);

  // Go back: return the previous caption to the top of the deck, undoing its
  // vote if it had one. Works after a funny/not-funny vote or a skip.
  const goBack = useCallback(async () => {
    const last = history[history.length - 1];
    if (!last) return;

    setHistory((prev) => prev.slice(0, -1));
    setExitDirection(last.action === "skip" ? "up" : last.action);
    setDeck((prev) => [last.card, ...prev]);

    if (last.action === "skip") return; // nothing was sent to the server

    try {
      // Wait for the original vote to land, then send the same vote again.
      // The vote action treats a repeated vote as "remove my vote".
      await last.request;
      await toggleCaptionVoteAction(last.card.id, voteValue(last.action));
    } catch (error) {
      console.error("Go back failed:", error);
      toast({
        title: "Couldn't undo that vote",
        variant: "destructive",
      });
    }
  }, [history, toast]);

  const setSaved = useCallback((id: string, isSaved: boolean) => {
    setDeck((prev) =>
      prev.map((card) =>
        card.id === id ? { ...card, is_saved: isSaved } : card
      )
    );
  }, []);

  const save = useCallback(
    async (card: SwipeCaption) => {
      setHeartBurstId(card.id);
      window.setTimeout(() => setHeartBurstId(null), 800);
      if (card.is_saved) return;

      setSaved(card.id, true);
      try {
        await insertSaveAction(card.id);
      } catch (error) {
        console.error("Save failed:", error);
        setSaved(card.id, false);
        toast({ title: "Couldn't save that caption", variant: "destructive" });
      }
    },
    [setSaved, toast]
  );

  const toggleSave = useCallback(
    async (card: SwipeCaption) => {
      if (!card.is_saved) {
        await save(card);
        return;
      }
      setSaved(card.id, false);
      try {
        await deleteSaveAction(card.id);
      } catch (error) {
        console.error("Unsave failed:", error);
        setSaved(card.id, true);
      }
    },
    [save, setSaved]
  );

  // Double-click / double-tap: save to Favorites, count it as funny, and move
  // on to the next caption in one gesture.
  const favoriteAndFunny = useCallback(
    (card: SwipeCaption) => {
      void save(card);
      swipe("right");
    },
    [save, swipe]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        swipe("right");
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        swipe("left");
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        skip();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        void goBack();
      } else if (event.key.toLowerCase() === "s" && topCard) {
        event.preventDefault();
        void toggleSave(topCard);
      } else if (event.key.toLowerCase() === "z" || event.key === "Backspace") {
        event.preventDefault();
        void goBack();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [swipe, skip, goBack, toggleSave, topCard]);

  // Keep the latest action callbacks in a ref so the wheel listener below can
  // stay mounted exactly once instead of re-subscribing on every deck change
  // (re-subscribing mid-gesture would drop the in-progress gesture state).
  const actionsRef = useRef({ swipe, skip, goBack });
  useEffect(() => {
    actionsRef.current = { swipe, skip, goBack };
  }, [swipe, skip, goBack]);

  // Two-finger trackpad swipes arrive as a stream of wheel events with a long
  // inertia tail. Treat one continuous stream (gaps < WHEEL_GAP_MS) as a single
  // gesture that fires at most once; a real pause starts the next gesture. This
  // is driven purely by the gap between events, so it can never get stuck.
  const wheelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = wheelRef.current;
    if (!el) return;

    let accX = 0;
    let accY = 0;
    let firedThisGesture = false;
    let lastEventTime = 0;

    const onWheel = (event: WheelEvent) => {
      const now = event.timeStamp;
      if (now - lastEventTime > WHEEL_GAP_MS) {
        // Fingers lifted since the last event: begin a fresh gesture.
        accX = 0;
        accY = 0;
        firedThisGesture = false;
      }
      lastEventTime = now;

      if (firedThisGesture) {
        event.preventDefault(); // swallow the inertia tail
        return;
      }

      accX += event.deltaX;
      accY += event.deltaY;
      if (Math.abs(accX) < WHEEL_THRESHOLD && Math.abs(accY) < WHEEL_THRESHOLD) {
        return;
      }

      event.preventDefault();
      firedThisGesture = true;
      const { swipe: s, skip: sk, goBack: gb } = actionsRef.current;
      if (Math.abs(accX) > Math.abs(accY)) {
        // Natural-scroll trackpad: swipe right → deltaX negative.
        if (accX < 0) s("right");
        else s("left");
      } else if (accY > 0) {
        sk(); // swipe up
      } else {
        void gb(); // swipe down
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // Mount once; the handler reads live callbacks from actionsRef, and only
    // refs/constants are referenced, so there are no reactive deps to track.
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center px-4 pb-10 pt-4">
      <div className="mb-3 flex w-full items-center justify-between text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Swipe to vote</span>
        <span>{deck.length} left</span>
      </div>

      <div
        ref={wheelRef}
        className="relative aspect-[3/4] w-full touch-none overscroll-none"
      >
        {deck.length === 0 ? (
          <EndOfDeck />
        ) : (
          <AnimatePresence initial={false} custom={exitDirection}>
            {deck
              .slice(0, 2)
              .reverse()
              .map((card) => {
                const isTop = card.id === topCard?.id;
                return (
                  <SwipeCard
                    key={card.id}
                    card={card}
                    isTop={isTop}
                    showHeart={heartBurstId === card.id}
                    onSwipe={swipe}
                    onSkip={skip}
                    onBack={() => void goBack()}
                    onDoubleTap={() => favoriteAndFunny(card)}
                  />
                );
              })}
          </AnimatePresence>
        )}
      </div>

      <div className="mt-7 flex items-end justify-center gap-2 sm:gap-3">
        <ActionButton
          label="Back"
          onClick={() => void goBack()}
          disabled={history.length === 0}
          variant="amber"
        >
          <Undo2 className="h-5 w-5" />
        </ActionButton>
        <ActionButton
          label="Not funny"
          onClick={() => swipe("left")}
          disabled={!topCard}
          variant="rose"
          primary
        >
          <X className="h-7 w-7" strokeWidth={3} />
        </ActionButton>
        <ActionButton
          label={topCard?.is_saved ? "Saved" : "Save"}
          onClick={() => topCard && void toggleSave(topCard)}
          disabled={!topCard}
          variant="pink"
          active={!!topCard?.is_saved}
        >
          <Heart
            className="h-5 w-5"
            fill={topCard?.is_saved ? "currentColor" : "none"}
          />
        </ActionButton>
        <ActionButton
          label="Funny"
          onClick={() => swipe("right")}
          disabled={!topCard}
          variant="emerald"
          primary
        >
          <Laugh className="h-7 w-7" strokeWidth={2.5} />
        </ActionButton>
        <ActionButton
          label="Skip"
          onClick={() => skip()}
          disabled={!topCard}
          variant="sky"
        >
          <ArrowUp className="h-5 w-5" />
        </ActionButton>
      </div>

      <p className="mt-6 hidden text-center text-xs leading-relaxed text-muted-foreground sm:block">
        Swipe, use the buttons, two-finger swipe on a trackpad, or arrow keys:
        <br />
        <span className="text-rose-500">←</span> not funny ·{" "}
        <span className="text-emerald-500">→</span> funny ·{" "}
        <span className="text-sky-500">↑</span> skip ·{" "}
        <span className="text-amber-500">↓</span> back · double-click = save +
        funny
      </p>
      <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground sm:hidden">
        Swipe right if it&apos;s funny, left if not. Swipe up to skip, down to go
        back. Double-tap to save it and mark it funny.
      </p>
    </div>
  );
}

function SwipeCard({
  card,
  isTop,
  showHeart,
  onSwipe,
  onSkip,
  onBack,
  onDoubleTap,
}: {
  card: SwipeCaption;
  isTop: boolean;
  showHeart: boolean;
  onSwipe: (direction: VoteDir) => void;
  onSkip: () => void;
  onBack: () => void;
  onDoubleTap: () => void;
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useTransform(x, [-250, 0, 250], [-18, 0, 18]);
  const funnyOpacity = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);
  const nopeOpacity = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
  const skipOpacity = useTransform(y, [-SWIPE_DISTANCE, -20], [1, 0]);
  const backOpacity = useTransform(y, [20, SWIPE_DISTANCE], [0, 1]);
  const lastTap = useRef(0);

  // Not far enough in any direction: spring the card back to the middle.
  const springBack = () => {
    const spring = { type: "spring", stiffness: 400, damping: 28 } as const;
    animate(x, 0, spring);
    animate(y, 0, spring);
  };

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    const { offset, velocity } = info;
    const horizontal = Math.abs(offset.x) > Math.abs(offset.y);

    if (horizontal) {
      let direction: VoteDir | null = null;
      if (offset.x > SWIPE_DISTANCE || velocity.x > SWIPE_VELOCITY) {
        direction = "right";
      } else if (offset.x < -SWIPE_DISTANCE || velocity.x < -SWIPE_VELOCITY) {
        direction = "left";
      }

      if (!direction) {
        springBack();
        return;
      }

      // Far enough: keep the card flying the way it was thrown, then vote.
      const sign = direction === "right" ? 1 : -1;
      const throwSpeed = Math.max(Math.abs(velocity.x), 800);
      animate(x, sign * 1000, {
        type: "tween",
        duration: 0.3,
        velocity: sign * throwSpeed,
      });
      animate(y, y.get() + velocity.y * 0.15, { type: "tween", duration: 0.3 });
      onSwipe(direction);
      return;
    }

    // Vertical: up skips the card (it flies off), down goes back a card.
    if (offset.y < -SWIPE_DISTANCE || velocity.y < -SWIPE_VELOCITY) {
      const throwSpeed = Math.max(Math.abs(velocity.y), 800);
      animate(y, -1000, {
        type: "tween",
        duration: 0.3,
        velocity: -throwSpeed,
      });
      animate(x, x.get() + velocity.x * 0.15, { type: "tween", duration: 0.3 });
      onSkip();
      return;
    }

    if (offset.y > SWIPE_DISTANCE || velocity.y > SWIPE_VELOCITY) {
      // The current card stays put; the previous card returns on top of it.
      springBack();
      onBack();
      return;
    }

    springBack();
  };

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTap.current < DOUBLE_TAP_MS) {
      lastTap.current = 0;
      onDoubleTap();
    } else {
      lastTap.current = now;
    }
  };

  return (
    // Outer layer owns enter/exit + stacking; inner layer owns the free drag,
    // so dragging never fights the mount/exit animation.
    <motion.div
      className="absolute inset-0"
      style={{ zIndex: isTop ? 2 : 1 }}
      initial={{ scale: 0.94, y: 12, opacity: 0.9 }}
      animate={
        isTop
          ? { scale: 1, y: 0, opacity: 1 }
          : { scale: 0.94, y: 12, opacity: 0.9 }
      }
      variants={exitVariants}
      exit="exit"
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <motion.div
        className="h-full w-full touch-none select-none"
        style={{ x, y, rotate }}
        drag={isTop}
        dragMomentum={false}
        dragElastic={1}
        onDragEnd={handleDragEnd}
        onTap={isTop ? handleTap : undefined}
        whileDrag={{ cursor: "grabbing", scale: 1.02 }}
      >
        <div className="relative h-full w-full cursor-grab overflow-hidden
          rounded-3xl bg-neutral-900 shadow-xl ring-1 ring-black/10">
          <img
            src={card.image_url}
            alt=""
            aria-hidden="true"
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full scale-125
              object-cover opacity-60 blur-2xl"
          />
          <img
            src={card.image_url}
            alt="Caption image"
            draggable={false}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />

          <div className="pointer-events-none absolute inset-x-0 bottom-0
            bg-gradient-to-t from-black/90 via-black/60 to-transparent
            px-5 pb-6 pt-24">
            <p className="text-lg font-semibold leading-snug text-white drop-shadow">
              {card.content}
            </p>
            <p className="mt-2 text-xs text-white/70">
              {card.like_count.toLocaleString()} likes
              {card.is_saved ? " · in your Favorites" : ""}
            </p>
          </div>

          {isTop && (
            <>
              <motion.div
                style={{ opacity: funnyOpacity }}
                className="pointer-events-none absolute left-5 top-6 -rotate-12
                  rounded-lg border-4 border-emerald-400 px-3 py-1 text-3xl
                  font-extrabold tracking-wider text-emerald-400"
              >
                FUNNY
              </motion.div>
              <motion.div
                style={{ opacity: nopeOpacity }}
                className="pointer-events-none absolute right-5 top-6 rotate-12
                  rounded-lg border-4 border-rose-500 px-3 py-1 text-3xl
                  font-extrabold tracking-wider text-rose-500"
              >
                NOPE
              </motion.div>
              <motion.div
                style={{ opacity: skipOpacity }}
                className="pointer-events-none absolute inset-x-0 top-6 flex
                  justify-center"
              >
                <span className="rounded-lg border-4 border-sky-400 px-3 py-1
                  text-3xl font-extrabold tracking-wider text-sky-400">
                  SKIP
                </span>
              </motion.div>
              <motion.div
                style={{ opacity: backOpacity }}
                className="pointer-events-none absolute inset-x-0 bottom-28 flex
                  justify-center"
              >
                <span className="rounded-lg border-4 border-amber-400 px-3 py-1
                  text-3xl font-extrabold tracking-wider text-amber-400">
                  BACK
                </span>
              </motion.div>
            </>
          )}

          <AnimatePresence>
            {showHeart && (
              <motion.div
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1.1, opacity: 1 }}
                exit={{ scale: 1.4, opacity: 0 }}
                transition={{ duration: 0.25 }}
              >
                <Heart
                  className="h-28 w-28 text-white drop-shadow-lg"
                  fill="currentColor"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}

type Variant = "rose" | "emerald" | "pink" | "amber" | "sky";

// Soft tinted circle per action; `active` fills it in (used for a saved card).
const variantStyles: Record<Variant, { base: string; active: string }> = {
  rose: {
    base:
      "bg-rose-50 text-rose-600 ring-rose-200 hover:bg-rose-100 " +
      "dark:bg-rose-500/10 dark:text-rose-400 dark:ring-rose-500/30 " +
      "dark:hover:bg-rose-500/20",
    active: "bg-rose-600 text-white ring-rose-600",
  },
  emerald: {
    base:
      "bg-emerald-50 text-emerald-600 ring-emerald-200 hover:bg-emerald-100 " +
      "dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/30 " +
      "dark:hover:bg-emerald-500/20",
    active: "bg-emerald-600 text-white ring-emerald-600",
  },
  pink: {
    base:
      "bg-pink-50 text-pink-600 ring-pink-200 hover:bg-pink-100 " +
      "dark:bg-pink-500/10 dark:text-pink-400 dark:ring-pink-500/30 " +
      "dark:hover:bg-pink-500/20",
    active: "bg-pink-500 text-white ring-pink-500",
  },
  amber: {
    base:
      "bg-amber-50 text-amber-600 ring-amber-200 hover:bg-amber-100 " +
      "dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/30 " +
      "dark:hover:bg-amber-500/20",
    active: "bg-amber-500 text-white ring-amber-500",
  },
  sky: {
    base:
      "bg-sky-50 text-sky-600 ring-sky-200 hover:bg-sky-100 " +
      "dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/30 " +
      "dark:hover:bg-sky-500/20",
    active: "bg-sky-500 text-white ring-sky-500",
  },
};

function ActionButton({
  label,
  onClick,
  disabled,
  variant,
  primary,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant: Variant;
  primary?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  const sizeClass = primary ? "h-16 w-16" : "h-12 w-12";
  const styles = variantStyles[variant];
  const colorClass = active ? styles.active : styles.base;
  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center justify-center rounded-full ring-1
          shadow-sm transition hover:scale-105 active:scale-95
          disabled:opacity-40 disabled:hover:scale-100 ${sizeClass}
          ${colorClass}`}
      >
        {children}
      </button>
      <span className="text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function EndOfDeck() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center
      gap-4 rounded-3xl border-2 border-dashed border-border px-6
      text-center">
      <Laugh className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">You&apos;ve seen them all</h2>
      <p className="text-sm text-muted-foreground">
        You voted on every caption in the stack. Check out the ones you saved.
      </p>
      <Link
        href="/favorites"
        className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-primary-foreground"
      >
        Go to Favorites
      </Link>
    </div>
  );
}
