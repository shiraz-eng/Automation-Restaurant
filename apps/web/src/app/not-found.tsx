import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-4 text-center">
      <h1 className="text-6xl font-black tracking-tight text-neutral-900">404</h1>
      <h2 className="mt-4 text-xl font-bold text-neutral-800">Page Not Found</h2>
      <p className="mt-2 text-sm text-neutral-600 max-w-md">
        The page you are looking for does not exist or has been moved.
      </p>
      <Link
        href="/"
        className="mt-6 inline-flex items-center rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-neutral-800 transition-colors"
      >
        Return Home
      </Link>
    </div>
  );
}
