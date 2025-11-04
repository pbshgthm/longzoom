import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-black px-6 text-white">
      <p className="font-medium text-xl">Page not found</p>
      <Link
        className="rounded-full border border-white/40 px-6 py-3 text-base text-white no-underline transition hover:border-white/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/80 focus-visible:outline-offset-2"
        href="/"
      >
        Go to home
      </Link>
    </div>
  );
}
