#!/bin/bash

# Ensure we're using Homebrew Ruby
export PATH="/opt/homebrew/opt/ruby/bin:$PATH"

echo "🚀 Starting Jekyll development server..."
echo "📝 Blog will be available at: http://127.0.0.1:4001"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

bundle exec jekyll serve --host 127.0.0.1 --port 4001 --livereload
