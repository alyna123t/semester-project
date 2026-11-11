import Link from "next/link";
import { checkAuthStatusAction } from "@/app/actions/auth/check-auth-status";
import { fetchSwipeDeckAction } from "@/app/actions/captions/fetch-swipe-deck-action";
import SwipeDeck from "@/components/swipe/swipe-deck";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Swipe | Crackd.ai",
};

export default async function SwipePage() {
  const auth = await checkAuthStatusAction();
  const isAuthenticated = auth.isAuthenticated && !auth.isAnonymous;

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-[calc(100vh-10rem)] flex-col items-center
        justify-center gap-4 px-4 text-center">
        <h1 className="text-2xl font-semibold">Swipe to vote</h1>
        <p className="max-w-sm text-muted-foreground">
          Log in to swipe through the funniest captions, vote on them, and save
          the ones you love.
        </p>
        <Link
          href="/login-with-email"
          className="rounded-full bg-primary px-6 py-2 font-medium text-primary-foreground"
        >
          Log in
        </Link>
      </div>
    );
  }

  const deck = await fetchSwipeDeckAction(50);

  return <SwipeDeck initialDeck={deck} />;
}
