import React from 'react';
import Link from 'next/link';

export function AdminHeader() {
  return (
    <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900">
      <div className="flex-1">
        <h1 className="text-xl font-bold text-white">SAAS OVERVIEW</h1>
        <p className="text-sm text-gray-400">Platform-level subscription, billing alerts, and signups</p>
      </div>
      <div className="flex items-center space-x-4">
        <Link href="/admin/profile" className="flex items-center space-x-2 text-gray-300 hover:text-white transition-colors">
          <span className="flex-shrink-0 h-6 w-6 bg-gray-800 rounded-full flex items-center justify-center text-xs font-medium">
            AB
          </span>
          <span className="hidden md:block">Admin User</span>
        </Link>
      </div>
    </header>
  );
}