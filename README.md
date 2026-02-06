# Antonello's Tech Blog

Personal blog featuring writings on software architecture, distributed systems, cloud infrastructure, and engineering leadership.

Built with [Jekyll](https://jekyllrb.com/) using the [Minima](https://github.com/jekyll/minima) theme.

## 🚀 Quick Start

### Prerequisites

- Ruby (version 2.7 or higher)
- Bundler: `gem install bundler`

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   bundle install
   ```

3. Run the development server:
   ```bash
   bundle exec jekyll serve
   ```

4. Open your browser to `http://localhost:4000`

### Development with Live Reload

```bash
bundle exec jekyll serve --livereload
```

## 📝 Writing Posts

Posts are stored in the `_posts` directory with the naming convention:

```
YYYY-MM-DD-title-of-post.md
```

### Post Front Matter

```yaml
---
layout: post
title: "Your Post Title"
date: YYYY-MM-DD
categories: [Category1, Category2]
tags: [tag1, tag2, tag3]
excerpt: "A brief description of your post"
---
```

## 📁 Project Structure

```
.
├── _config.yml          # Jekyll configuration
├── _posts/              # Blog posts (120 posts)
├── _layouts/            # Page layouts from Minima theme
├── _includes/           # Reusable components
├── _sass/               # Stylesheets
├── assets/              # CSS, images, etc.
├── index.md             # Homepage
├── about.md             # About page
├── 404.html             # 404 error page
└── Gemfile              # Ruby dependencies
```

## 🎨 Customization

### Theme Configuration

The site uses the Minima theme with the "auto" skin (adapts to light/dark mode).

To change the theme skin, edit `_config.yml`:

```yaml
minima:
  skin: auto  # Options: classic, dark, auto, solarized, solarized-light, solarized-dark
```

### Navigation

Update navigation links in `_config.yml`:

```yaml
minima:
  nav_pages:
    - about.md
    - index.md
```

### Social Links

Configure social media links in `_config.yml`:

```yaml
minima:
  social_links:
    - title: GitHub
      icon: github
      url: "https://github.com/username"
```

## 🏗️ Building for Production

Generate the static site:

```bash
bundle exec jekyll build
```

The built site will be in the `_site` directory.

## 📊 Blog Statistics

- **Total Posts:** 120
- **Years:** 2016 - 2025
- **Topics:** Cloud Architecture, Distributed Systems, DevOps, AI/ML, Engineering Leadership

## 🛠️ Tech Stack

- **Framework:** Jekyll 4.3
- **Theme:** Minima 2.5
- **Plugins:** 
  - jekyll-feed (RSS feed generation)
  - jekyll-seo-tag (SEO optimization)
- **Markdown:** Kramdown with GitHub Flavored Markdown

## 📄 License

Content is personal intellectual property. Code is available under the theme's license (MIT).

## 🔗 Links

- **Website:** [antonello.dev](https://www.antonello.dev)
- **GitHub:** [@antonellof](https://github.com/antonellof)
- **X.com:** [@hack_the_cloud](https://x.com/hack_the_cloud)

---

Made with ❤️ using Jekyll and Minima
