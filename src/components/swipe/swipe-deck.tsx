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
import { Bookmark, Heart, Laugh, SkipForward, Undo2, X } from "lucide-react";
import {
  deleteSaveAction,
  insertSaveAction,
  toggleCaptionVoteAction,
} from "@/app/actions/captions";
import type { SwipeCaption } from "@/app/actions/captions/fetch-swipe-deck-action";
import { useToast } from "@/hooks/use-toast";
import { createWheelGesture } from "./wheel-gesture";

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
// Max gap between the two taps of a double-tap. OS double-click defaults are
// ~500ms, so anything much tighter misses a lot of real double-taps/clicks.
const DOUBLE_TAP_MS = 450;
// After a double-tap the heart pops on the card for this long before the card
// flies off, so you can see it was saved and not just swiped.
const DOUBLE_TAP_HOLD_MS = 260;
const BURST_MS = 900;

const exitVariants = {
  exit: (direction: ExitDir) => ({
    x: direction === "right" ? 1200 : direction === "left" ? -1200 : 0,
    y: direction === "up" ? -1200 : 0,
    opacity: 0,
    // A card that's leaving must not catch taps or drags meant for the next
    // one (AnimatePresence keeps it mounted with its old `isTop` props).
    pointerEvents: "none" as const,
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
  // Short-lived "saved" overlay shown over the stack (not inside a card, so it
  // still shows while the card it belongs to is flying away).
  const [burst, setBurst] = useState<string | null>(null);
  const burstTimer = useRef<number | null>(null);
  const { toast } = useToast();

  const topCard = deck[0];

  const flashBurst = useCallback((label: string) => {
    if (burstTimer.current) window.clearTimeout(burstTimer.current);
    setBurst(label);
    burstTimer.current = window.setTimeout(() => setBurst(null), BURST_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (burstTimer.current) window.clearTimeout(burstTimer.current);
    };
  }, []);

  // Vote on `card` (defaults to the top card) and remove it from the deck. The
  // card is removed by id so a delayed call still targets the right one.
  const swipe = useCallback(
    (direction: VoteDir, target?: SwipeCaption) => {
      const card = target ?? deck[0];
      if (!card) return;

      setExitDirection(direction);
      setDeck((prev) => prev.filter((c) => c.id !== card.id));

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
    async (card: SwipeCaption, { quiet = false } = {}) => {
      if (!quiet) flashBurst(card.is_saved ? "Already saved" : "Saved");
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
    [flashBurst, setSaved, toast]
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
  // on to the next caption in one gesture. The heart pops first, then the card
  // flies right, so it reads as "saved" rather than a plain funny swipe.
  const favoriteAndFunny = useCallback(
    (card: SwipeCaption) => {
      flashBurst("Saved + Funny");
      void save(card, { quiet: true });
      window.setTimeout(() => swipe("right", card), DOUBLE_TAP_HOLD_MS);
    },
    [flashBurst, save, swipe]
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

    const gesture = createWheelGesture();

    const onWheel = (event: WheelEvent) => {
      // Capture EVERY wheel over the card so the page never scrolls while you
      // swipe on the photo. Off the photo this listener isn't attached, so the
      // rest of the page scrolls normally.
      event.preventDefault();

      const action = gesture(event);
      if (!action) return;
      const { swipe: s, skip: sk, goBack: gb } = actionsRef.current;
      if (action === "right" || action === "left") s(action);
      else if (action === "up") sk();
      else void gb();
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
                    onSwipe={swipe}
                    onSkip={skip}
                    onBack={() => void goBack()}
                    onDoubleTap={() => favoriteAndFunny(card)}
                  />
                );
              })}
          </AnimatePresence>
        )}

        <AnimatePresence>
          {burst && (
            <motion.div
              key={burst}
              data-testid="save-burst"
              className="pointer-events-none absolute inset-0 z-10 flex flex-col
                items-center justify-center gap-2"
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 1.3, opacity: 0 }}
              transition={{ type: "spring", stiffness: 500, damping: 26 }}
            >
              <Heart
                className="h-28 w-28 text-white drop-shadow-lg"
                fill="currentColor"
              />
              <span className="bg-black/70 px-3 py-1 text-sm font-semibold
                tracking-wide text-white">
                {burst}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Two big decisions in the middle; small helpers either side. */}
      <div className="mt-6 flex w-full items-end justify-center gap-3 sm:gap-4">
        <ActionButton
          label="Undo"
          onClick={() => void goBack()}
          disabled={history.length === 0}
          kind="secondary"
        >
          <Undo2 className="h-5 w-5" />
        </ActionButton>
        <ActionButton
          label="Not funny"
          onClick={() => swipe("left")}
          disabled={!topCard}
          kind="primary"
          tone="rose"
        >
          <X className="h-8 w-8" strokeWidth={3} />
        </ActionButton>
        <ActionButton
          label={topCard?.is_saved ? "Saved" : "Save"}
          onClick={() => topCard && void toggleSave(topCard)}
          disabled={!topCard}
          kind="secondary"
          active={!!topCard?.is_saved}
        >
          <Bookmark
            className="h-5 w-5"
            fill={topCard?.is_saved ? "currentColor" : "none"}
          />
        </ActionButton>
        <ActionButton
          label="Funny"
          onClick={() => swipe("right")}
          disabled={!topCard}
          kind="primary"
          tone="emerald"
        >
          <Laugh className="h-8 w-8" strokeWidth={2.5} />
        </ActionButton>
        <ActionButton
          label="Skip"
          onClick={() => skip()}
          disabled={!topCard}
          kind="secondary"
        >
          <SkipForward className="h-5 w-5" />
        </ActionButton>
      </div>

      <p className="mt-6 hidden text-center text-xs leading-relaxed text-muted-foreground sm:block">
        Drag the card, two-finger swipe on a trackpad, or use the arrow keys:
        <br />
        <span className="text-rose-500">←</span> not funny ·{" "}
        <span className="text-emerald-500">→</span> funny ·{" "}
        <span className="text-foreground">↑</span> skip ·{" "}
        <span className="text-foreground">↓</span> undo ·{" "}
        <span className="text-foreground">S</span> save
        <br />
        Double-click a card to save it <em>and</em> mark it funny.
      </p>
      <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground sm:hidden">
        Swipe right if it&apos;s funny, left if not. Swipe up to skip, down to
        undo. Double-tap a card to save it and mark it funny.
      </p>
    </div>
  );
}

function SwipeCard({
  card,
  isTop,
  onSwipe,
  onSkip,
  onBack,
  onDoubleTap,
}: {
  card: SwipeCaption;
  isTop: boolean;
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
  const lastPointerDown = useRef(0);
  // Set once this card has been voted/skipped/double-tapped from a gesture, so
  // extra taps or a drag during the short hold-before-fly-off are ignored
  // (a repeat vote on the same caption would toggle it back off).
  const done = useRef(false);

  // Not far enough in any direction: spring the card back to the middle.
  const springBack = () => {
    const spring = { type: "spring", stiffness: 400, damping: 28 } as const;
    animate(x, 0, spring);
    animate(y, 0, spring);
  };

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (done.current) {
      springBack();
      return;
    }
    const { offset, velocity } = info;

    // Work out which thresholds each axis crossed, independently.
    const horizontal: VoteDir | null =
      offset.x > SWIPE_DISTANCE || velocity.x > SWIPE_VELOCITY
        ? "right"
        : offset.x < -SWIPE_DISTANCE || velocity.x < -SWIPE_VELOCITY
          ? "left"
          : null;
    const vertical: "up" | "down" | null =
      offset.y < -SWIPE_DISTANCE || velocity.y < -SWIPE_VELOCITY
        ? "up"
        : offset.y > SWIPE_DISTANCE || velocity.y > SWIPE_VELOCITY
          ? "down"
          : null;

    // If a gesture crosses both axes, the larger movement wins; otherwise take
    // whichever axis actually crossed. This lets a mostly-vertical swipe still
    // register even when it drifts a little sideways, instead of springing back.
    let action: VoteDir | "up" | "down" | null;
    if (horizontal && vertical) {
      action = Math.abs(offset.x) >= Math.abs(offset.y) ? horizontal : vertical;
    } else {
      action = horizontal ?? vertical;
    }

    if (action === "right" || action === "left") {
      // Keep the card flying the way it was thrown, then vote.
      const sign = action === "right" ? 1 : -1;
      const throwSpeed = Math.max(Math.abs(velocity.x), 800);
      animate(x, sign * 1000, {
        type: "tween",
        duration: 0.3,
        velocity: sign * throwSpeed,
      });
      animate(y, y.get() + velocity.y * 0.15, { type: "tween", duration: 0.3 });
      done.current = true;
      onSwipe(action);
      return;
    }

    if (action === "up") {
      // Up skips the card (it flies off the top).
      const throwSpeed = Math.max(Math.abs(velocity.y), 800);
      animate(y, -1000, {
        type: "tween",
        duration: 0.3,
        velocity: -throwSpeed,
      });
      animate(x, x.get() + velocity.x * 0.15, { type: "tween", duration: 0.3 });
      done.current = true;
      onSkip();
      return;
    }

    if (action === "down") {
      // The current card stays put; the previous card returns on top of it.
      springBack();
      onBack();
      return;
    }

    springBack();
  };

  // Double-tap / double-click to favorite. Framer's drag gesture calls
  // preventDefault on the pointer stream, which suppresses native dblclick and
  // makes onTap fire unreliably, so detect it from raw pointerdown events, which
  // nothing swallows. The ref is per-card, and a card is gone after one swipe,
  // so two pointerdowns here can only mean a genuine double-tap on this card.
  const handlePointerDown = (event: React.PointerEvent) => {
    // Primary button / first finger only: no right-clicks or second fingers.
    if (done.current || event.button !== 0 || !event.isPrimary) return;
    const now = Date.now();
    if (now - lastPointerDown.current < DOUBLE_TAP_MS) {
      lastPointerDown.current = 0;
      done.current = true;
      onDoubleTap();
    } else {
      lastPointerDown.current = now;
    }
  };

  // A press that turns into a drag isn't the first half of a double-tap.
  const handleDragStart = () => {
    lastPointerDown.current = 0;
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
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onPointerDown={isTop ? handlePointerDown : undefined}
        data-testid={isTop ? "top-card" : undefined}
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
        </div>
      </motion.div>
    </motion.div>
  );
}

// The app is square-cornered everywhere (globals.css zeroes border-radius), so
// these are deliberately plain squares: two big solid ones for the vote, three
// small outlined ones for the helpers.
const primaryTones = {
  rose: "bg-rose-500 text-white hover:bg-rose-600 active:bg-rose-700",
  emerald:
    "bg-emerald-500 text-white hover:bg-emerald-600 active:bg-emerald-700",
} as const;

function ActionButton({
  label,
  onClick,
  disabled,
  kind,
  tone,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  kind: "primary" | "secondary";
  tone?: keyof typeof primaryTones;
  active?: boolean;
  children: React.ReactNode;
}) {
  const isPrimary = kind === "primary";
  const shapeClass = isPrimary
    ? `h-16 w-16 shadow-md ${primaryTones[tone ?? "emerald"]}`
    : active
      ? "h-11 w-11 border border-foreground bg-foreground text-background"
      : "h-11 w-11 border border-border bg-background text-muted-foreground " +
        "hover:border-foreground hover:text-foreground";
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={onClick}
        disabled={disabled}
        className={`flex items-center justify-center transition
          hover:-translate-y-0.5 active:translate-y-0
          disabled:cursor-not-allowed disabled:opacity-35
          disabled:hover:translate-y-0 ${shapeClass}`}
      >
        {children}
      </button>
      <span
        className={`text-[11px] ${
          isPrimary
            ? "font-semibold text-foreground"
            : "font-medium text-muted-foreground"
        }`}
      >
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
