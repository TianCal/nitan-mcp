# Nitan MCP Tools Reference

This document describes the tools available in this Discourse MCP server, including both standard Discourse API tools and custom enhancements for uscardforum.com.

## Core Discourse Tools

### discourse_search
Search site content with optional filters and sorting.

**Input:**
```json
{
  "query": "credit card rewards",  // Optional if any filter below is given
  "max_results": 10,               // Optional: 1-50, default 50
  "order": "latest",               // Optional: relevance (default), likes, latest, views, latest_topic
  "category": "玩卡",               // Optional: Chinese category name
  "author": "john_doe",            // Optional
  "after": "2026-01-01",           // Optional: YYYY-MM-DD
  "before": "2026-02-01",          // Optional: YYYY-MM-DD
  "topic_id": 541783               // Optional: search only inside this topic
}
```

**Output:** JSON array, one entry per topic: `topic_id`, `url`, `title`, `category`, `tags`, `posts_count`,
and for the first matching post `post_number`, `author`, `posted_at`, `like_count`, `blurb`.
Calling it with no query and no filter returns a tool error.

With `topic_id`, results are the matching posts of that topic instead of topics:
`post_number`, `url`, `author`, `posted_at`, `like_count`, `blurb`. Combine with `order: "likes"` to rank them.

---

### discourse_read_topic
Read a topic's metadata and posts. Can optionally filter to show only posts from a specific user.

**Input:**
```json
{
  "topic_id": 12345,
  "post_limit": 90,          // Optional: 1-500, default 90
  "start_post_number": 1,    // Optional: start from specific post
  "username_filter": "john",  // Optional: only posts by this user
  "order": "likes",          // Optional: "default" (thread order) or "likes" (most-liked first, up to 200 posts)
  "include_images": 3        // Optional: attach up to N images from the returned posts (0-10, default 0)
}
```

**Output:**
- Topic title, category name, tags
- Posts with author, timestamp, and content
- Canonical topic link

Post content returned by one call is capped at `--max-read-length` characters (default 50000).
When the cap or `post_limit` cuts the topic short, the output ends with
`Continue with start_post_number=N`. With `order: "likes"` each post shows its like count and
`start_post_number` is ignored.

`upload://…` references in post content are rewritten to `https://<site>/uploads/short-url/…` links.
With `include_images`, the first N of those images (site-hosted only, up to 2 MB each) are returned as
MCP image content, each preceded by a text block naming its post.

---

### discourse_get_user_activity
Get a list of user posts and replies from a Discourse instance, with the most recent first. Returns 30 posts per page by default.

**Input:**
```json
{
  "username": "john_doe",
  "page": 0  // Optional: page 0 = offset 0, page 1 = offset 30, etc.
}
```

**Output:**
- List of user's recent posts and replies
- Post content, topic titles, and links
- Pagination information

---

## Custom Enhanced Tools

### 1. discourse_list_hot_topics
Get the current hot/trending topics from the forum. Hot topics are based on recent activity, views, and engagement.

**Input:**
```json
{
  "limit": 10  // Optional: 1-50, default 10
}
```

**Output:**
- List of hot topics with titles, categories, and URLs
- JSON footer with structured data

**Example:**
```json
{
  "limit": 20
}
```

---

### 2. discourse_list_notifications
Get user notifications from the forum. Requires authentication with user credentials.

**Input:**
```json
{
  "limit": 30,        // Optional: 1-60, default 30
  "unread_only": true // Optional: default true
}
```

**Output:**
- List of notifications with type, title, and links
- Unread count and total count

**Example:**
```json
{
  "limit": 50,
  "unread_only": false
}
```

---

### 3. discourse_list_top_topics
Get the top topics from the forum for a specific time period (daily, weekly, monthly, quarterly, yearly, or all time). Top topics are ranked by activity, views, and engagement.

**Input:**
```json
{
  "period": "daily",  // Required: daily/weekly/monthly/quarterly/yearly/all
  "limit": 10         // Optional: 1-50, default 10
}
```

**Output:**
- List of top topics for the period with titles, categories, and URLs
- JSON footer with structured data

**Example:**
```json
{
  "period": "weekly",
  "limit": 25
}
```

---

### 4. discourse_list_excellent_topics
Get recent excellent topics from the forum. An excellent topic is a topic with over 50 likes that earned the "精彩的话题" (Excellent Topic) badge.

**Input:**
```json
{
  "limit": 10  // Optional: 1-50, default 10
}
```

**Output:**
- List of recent excellent topics with structured JSON data
- Each entry includes: topic ID, username of author, title, post count, and when it achieved excellence

**Example:**
```json
{
  "limit": 20
}
```

**Output format:**
```json
{
  "results": [
    {
      "id": 452676,
      "username": "leena",
      "title": "体会到了"他乡遇故知"是一件多么美好的事情！",
      "posts_count": 21,
      "granted_at": "2025-11-02T21:16:19.542Z"
    }
  ]
}
```

---

## Category Support

`discourse_search` accepts Chinese category names in its `category` argument (e.g. 玩卡, 旅行, 理财)
and converts them to category IDs. Topic lists show category names instead of IDs.

---

## Hardcoded Category Mapping

The tool now includes a hardcoded mapping of all uscardforum.com categories with:
- Category IDs
- Display names (natural language)
- URL slugs
- Descriptions
- Parent-child relationships

### Available Functions (src/tools/categories.ts)

```typescript
// Get category by ID
getCategoryById(id: number): Category | undefined

// Get category by natural language name
getCategoryByName(name: string): Category | undefined

// Get category display name (with fallback to slug)
getCategoryName(id: number, slug: string): string

// Get subcategories of a category
getSubcategories(parentId: number): Category[]

// Get all categories
getAllCategories(): Category[]
```

### Category Examples

```typescript
// Major categories
"Chase Credit Cards" (id: 3)
"American Express" (id: 4)
"Credit Card Basics" (id: 66)
"Points and Miles Strategy" (id: 11)
"Debit Cards & Bank Accounts" (id: 9)

// Subcategories
"Chase Sapphire Reserve" (id: 115, parent: Chase Credit Cards)
"Chase Sapphire Preferred" (id: 116, parent: Chase Credit Cards)
"Amex Platinum Card" (id: 117, parent: American Express)
```

See `src/tools/categories.ts` for the complete mapping.

---

## Tool Availability

### Authentication-Required Tools
These tools require authentication via `--username` and `--password`:
- `discourse_list_notifications`
- `discourse_get_user_activity` (for private content)

### Removed Tools
`discourse_read_post`, `discourse_get_user`, `discourse_filter_topics`, `discourse_list_tags` and
`discourse_list_categories` were not registered and their sources have been removed.
For categories, see `src/tools/categories.ts`.

---

## Authentication

Some read operations (like notifications) require authentication:

```bash
nitan-mcp \
  --site https://www.uscardforum.com/ \
  --use_cloudscraper \
  --username YOUR_USERNAME \
  --password YOUR_PASSWORD
```

---

## Cloudflare Bypass

This fork includes automatic Cloudflare bypass with two methods:

1. **cloudscraper** - Traditional Python cloudscraper library
2. **curl_cffi** - Modern curl-impersonate library (faster and more reliable)
3. **both** (default) - Tries cloudscraper first, falls back to curl_cffi

```bash
# Use default (both methods with fallback)
nitan-mcp

# Use curl_cffi only (recommended for best performance)
nitan-mcp --bypass-method curl_cffi

# Use cloudscraper only
nitan-mcp --bypass-method cloudscraper

# Specify Python path if needed
nitan-mcp --bypass-method both --python-path /usr/local/bin/python3

# Increase timeout for slow responses
nitan-mcp --bypass-method both --timeout-ms 30000

# Legacy flag (still supported, equivalent to --bypass-method both)
nitan-mcp --use-cloudscraper
```

**Requirements:**
- Python 3.7+
- `pip3 install cloudscraper curl-cffi`

Or install all requirements:
```bash
pip3 install -r requirements.txt
```

The postinstall script attempts to install these dependencies automatically.

**Error Messages:**
If Python or dependencies are missing, you'll see bilingual error messages (English and Chinese) with instructions on how to install the required packages.

---

## Examples

### Get Weekly Top Topics
```json
{
  "period": "weekly",
  "limit": 30
}
```

### Check Unread Notifications
```json
{
  "unread_only": true,
  "limit": 50
}
```

### Browse Hot Topics
```json
{
  "limit": 25
}
```

### Get Excellent Topics (50+ likes)
```json
{
  "limit": 15
}
```

### Get Funny Topics
```json
{
  "limit": 15
}
```
