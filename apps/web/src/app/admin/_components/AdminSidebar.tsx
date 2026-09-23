import React from 'react';
import Link from 'next/link';

export function AdminSidebar() {
  return (
    <aside className="w-64 bg-gray-950 border-r border-gray-800 flex flex-col p-4">
      <div className="flex items-center space-x-3 mb-6">
        <div className="h-8 w-8 bg-yellow-500 rounded"></div>
        <span className="text-xl font-bold text-yellow-500">Automation Restaurant</span>
      </div>

      <nav className="flex-1">
        <Link href="/" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Overview</span>
        </Link>
        <Link href="/features" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Features</span>
        </Link>
        <Link href="/pricing" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Pricing</span>
        </Link>
        <Link href="/about" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">About</span>
        </Link>
        <Link href="/use-cases" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Use Cases</span>
        </Link>
        <Link href="/buyers" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Buyers</span>
        </Link>
        <Link href="/customers" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Customers</span>
        </Link>
        <Link href="/restaurants" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Restaurants</span>
        </Link>
        <Link href="/users" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Users</span>
        </Link>
        <Link href="/subscriptions" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Subscriptions</span>
        </Link>
        <Link href="/settings" className="group flex items-center space-x-3 px-3 py-2 rounded-md text-gray-300 hover:bg-gray-800 hover:text-white transition-colors">
          <span className="flex-shrink-0">Settings</span>
        </Link>
      </nav>

      <div className="mt-auto pt-4 border-t border-gray-800">
        <p className="text-xs text-gray-500">Platform Administration</p>
      </div>
    </aside>
  );
}