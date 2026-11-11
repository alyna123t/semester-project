"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  type PanInfo,
} from "framer-motion";
import { Heart, Laugh, Undo2, X } from "lucide-react";
import {
  deleteSaveAction,
  insertSaveAction,
  toggleCaptionVoteAction,
} from "@/app/actions/captions";
import type { SwipeCaption } from "@/app/actions/captions/fetch-swipe-deck-action";
import { useToast } from "@/hooks/use-toast";

type Direction = "left" | "right";

type HistoryEntry = {
  card: SwipeCaption;
  direction: Direction;
  request: Promise<unknown>;
};

const SWIPE_DISTANCE = 120;
const SWIPE_VELOCITY = 500;
const DOUBLE_TAP_MS = 300;

const exitVariants = {
  exit: (direction: Direction) => ({
    x: direction === "right" ? 600 : -600,
    rotate: direction === "right" ? 25 : -25,
    opacity: 0,
    transition: { duration: 0.3 },
  }),
};

const voteValue = (direction: Direction): 1 | -1 =>
  direction === "right" ? 1 : -1;

export default function SwipeDeck({
  initialDeck,
}: {
  initialDeck: SwipeCaption[];
}) {
  const [deck, setDeck] = useState<SwipeCaption[]>(initialDeck);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [exitDirection, setExitDirection] = useState<Direction>("right");
  const [heartBurstId, setHeartBurstId] = useState<string | null>(null);
  const { toast } = useToast();

  const topCard = deck[0];

  const swipe = useCallback(
    (direction: Direction) => {
      const card = deck[0];
      if (!card) return;

      setExitDirection(direction);
      setDeck((prev) => prev.slice(1));

      const request = toggleCaptionVoteAction(card.id, voteValue(direction)).catch(
        (error) => {
          console.error("Vote failed:", error);
          toast({
            title: "Your vote didn't save",
            description: "Check your connection and try again.",
            variant: "destructive",
          });
        }
      );

      setHistory((prev) => [...prev, { card, direction, request }]);
    },
    [deck, toast]
  );

  const undo = useCallback(async () => {
    const last = history[history.length - 1];
    if (!last) return;

    setHistory((prev) => prev.slice(0, -1));
    setExitDirection(last.direction);
    setDeck((prev) => [last.card, ...prev]);

    try {
      // Wait for the original vote to land, then send the same vote again.
      // The vote action treats a repeated vote as "remove my vote".
      await last.request;
      await toggleCaptionVoteAction(last.card.id, voteValue(last.direction));
    } catch (error) {
      console.error("Undo failed:", error);
      toast({
        title: "Couldn't undo that vote",
        variant: "destructive",
      });
    }
  }, [history, toast]);

  const setSaved = useCallback((id: string, isSaved: boolean) => {
    setDeck((prev) =>
      prev.map((card) => (card.id === id ? { ...card, is_saved: isSaved } : card))
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
    [save, setSaved, toast]
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
      } else if (event.key.toLowerCase() === "s" && topCard) {
        event.preventDefault();
        void toggleSave(topCard);
      } else if (event.key.toLowerCase() === "z" || event.key === "Backspace") {
        event.preventDefault();
        void undo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [swipe, toggleSave, undo, topCard]);

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center px-4 pb-10 pt-4">
      <div className="mb-3 flex w-full items-center justify-between text-sm text-muted-foreground">
        <span className="font-medium text-foreground">Swipe to vote</span>
        <span>{deck.length} left</span>
      </div>

      <div className="relative aspect-[3/4] w-full">
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
                    onDoubleTap={() => void save(card)}
                  />
                );
              })}
          </AnimatePresence>
        )}
      </div>

      <div className="mt-6 flex items-center justify-center gap-4">
        <RoundButton
          label="Undo last swipe"
          onClick={() => void undo()}
          disabled={history.length === 0}
          className="h-11 w-11 text-amber-500"
        >
          <Undo2 className="h-5 w-5" />
        </RoundButton>
        <RoundButton
          label="Not funny"
          onClick={() => swipe("left")}
          disabled={!topCard}
          className="h-16 w-16 text-rose-500"
        >
          <X className="h-8 w-8" strokeWidth={3} />
        </RoundButton>
        <RoundButton
          label={topCard?.is_saved ? "Remove from Favorites" : "Save to Favorites"}
          onClick={() => topCard && void toggleSave(topCard)}
          disabled={!topCard}
          className="h-11 w-11 text-pink-500"
        >
          <Heart
            className="h-5 w-5"
            fill={topCard?.is_saved ? "currentColor" : "none"}
          />
        </RoundButton>
        <RoundButton
          label="Funny"
          onClick={() => swipe("right")}
          disabled={!topCard}
          className="h-16 w-16 text-emerald-500"
        >
          <Laugh className="h-8 w-8" strokeWidth={2.5} />
        </RoundButton>
      </div>

      <p className="mt-5 hidden text-center text-xs text-muted-foreground sm:block">
        ← not funny · → funny · S save · Z undo · double click to save
      </p>
      <p className="mt-5 text-center text-xs text-muted-foreground sm:hidden">
        Swipe right if it&apos;s funny, left if it&apos;s not. Double tap to save.
      </p>
    </div>
  );
}

function SwipeCard({
  card,
  isTop,
  showHeart,
  onSwipe,
  onDoubleTap,
}: {
  card: SwipeCaption;
  isTop: boolean;
  showHeart: boolean;
  onSwipe: (direction: Direction) => void;
  onDoubleTap: () => void;
}) {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-250, 0, 250], [-18, 0, 18]);
  const funnyOpacity = useTransform(x, [20, SWIPE_DISTANCE], [0, 1]);
  const nopeOpacity = useTransform(x, [-SWIPE_DISTANCE, -20], [1, 0]);
  const lastTap = useRef(0);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > SWIPE_DISTANCE || info.velocity.x > SWIPE_VELOCITY) {
      onSwipe("right");
    } else if (
      info.offset.x < -SWIPE_DISTANCE ||
      info.velocity.x < -SWIPE_VELOCITY
    ) {
      onSwipe("left");
    }
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
    <motion.div
      className="absolute inset-0 touch-none select-none"
      style={{ x, rotate, zIndex: isTop ? 2 : 1 }}
      drag={isTop ? "x" : false}
      dragSnapToOrigin
      dragElastic={0.9}
      onDragEnd={handleDragEnd}
      onTap={isTop ? handleTap : undefined}
      initial={{ scale: 0.94, y: 12, opacity: 0.9 }}
      animate={
        isTop
          ? { scale: 1, y: 0, opacity: 1 }
          : { scale: 0.94, y: 12, opacity: 0.9 }
      }
      variants={exitVariants}
      exit="exit"
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      whileDrag={{ cursor: "grabbing" }}
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
  );
}

function RoundButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center rounded-full bg-background
        shadow-md ring-1 ring-border transition hover:scale-110
        active:scale-95 disabled:opacity-40 disabled:hover:scale-100
        ${className ?? ""}`}
    >
      {children}
    </button>
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
