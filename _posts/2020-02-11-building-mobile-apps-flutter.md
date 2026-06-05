---
layout: post
title: "Building Mobile Apps with Flutter: A Practical Guide"
date: 2020-02-11
categories: [How-To]
tags: [Flutter, Mobile, Dart]
excerpt: "We shipped iOS and Android from one codebase and finally stopped pretending React Native hot reload was enough. A practical Flutter guide covering widgets, state management, and the stuff that actually bites you in production."
---

In 2019, my team maintained two mobile apps that were supposed to be "the same product." They weren't. Android had a feature iOS wouldn't get for six weeks. iOS had animations Android couldn't replicate without a native plugin written by someone who'd left the company. We were paying for two codebases, two QA cycles, and twice the bug reports.

Then we tried Flutter.

I was skeptical—another cross-platform framework, another "write once, run everywhere" promise. But after shipping our first production app with Flutter 1.12, I stopped maintaining separate iOS and Android feature branches. One codebase. Real native performance. Hot reload that actually works. I'm still using it.

This isn't a "hello world" tutorial. It's what I wish someone had told me before our first production deploy: project structure, state management choices, navigation patterns, and the API integration gotchas that don't show up in the docs.

## Why Flutter (And When Not To)

Flutter compiles to native ARM code. It doesn't use a WebView or bridge to native components—it draws its own UI with Skia. That means:
- Consistent look across platforms (or platform-adaptive if you want)
- 60fps animations without begging the JS bridge
- One language (Dart) for UI and business logic

**Skip Flutter if:** you need heavy platform-specific native UI (Apple's latest design language day-one), your team is 100% Swift/Kotlin with no appetite for Dart, or you're building something deeply tied to OS APIs Flutter doesn't wrap well.

**Reach for Flutter if:** you want one team shipping both platforms, your app is mostly custom UI, or you're tired of "works on my iPhone, crashes on Samsung."

## Getting Started Without the Pitfalls

### Installation

```bash
# Install Flutter SDK
git clone https://github.com/flutter/flutter.git
export PATH="$PATH:`pwd`/flutter/bin"

# Verify — fix everything flutter doctor complains about
flutter doctor

# Create new project
flutter create my_app
cd my_app
flutter run
```

Run `flutter doctor` obsessively at the start. Xcode licenses, Android SDK paths, CocoaPods—half of "Flutter doesn't work" tickets are environment setup, not Flutter.

### Project Structure That Scales

The default `lib/main.dart` blob works for demos. Production apps need structure:

```
lib/
├── main.dart              # App entry, providers, routes
├── models/                # Data classes (User, Order, etc.)
├── screens/               # Full-page widgets
├── widgets/               # Reusable UI components
├── services/              # API clients, storage, auth
└── utils/                 # Helpers, constants, extensions
```

I keep screens dumb (UI only), services smart (API/storage), and models immutable where possible. Your future self will thank you when you add a second screen that needs the same API call.

## Widgets: Everything Is a Widget (Yes, Really)

Flutter's core insight: the UI is a function of state. `build()` returns a widget tree. State changes → tree rebuilds → Flutter diffs and repaints efficiently.

### Stateless Widgets: Pure Presentation

Use when the widget doesn't manage its own mutable state:

```dart
import 'package:flutter/material.dart';

class MyWidget extends StatelessWidget {
  final String title;
  
  const MyWidget({Key? key, required this.title}) : super(key: key);
  
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
      ),
      body: Center(
        child: Text('Hello Flutter!'),
      ),
    );
  }
}
```

Pro tip: use `const` constructors everywhere you can. Flutter skips rebuilding const widgets—free performance.

### Stateful Widgets: When Things Change

Counter app territory, but the pattern applies everywhere:

```dart
class CounterWidget extends StatefulWidget {
  @override
  _CounterWidgetState createState() => _CounterWidgetState();
}

class _CounterWidgetState extends State<CounterWidget> {
  int _counter = 0;
  
  void _incrementCounter() {
    setState(() {
      _counter++;
    });
  }
  
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text('Counter')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('You have pushed the button this many times:'),
            Text(
              '$_counter',
              style: Theme.of(context).textTheme.headline4,
            ),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _incrementCounter,
        tooltip: 'Increment',
        child: Icon(Icons.add),
      ),
    );
  }
}
```

`setState()` is your signal to Flutter: "rebuild this subtree." Don't call it from `build()` unless you enjoy infinite loops.

## State Management: The Debate Nobody Wins

Every Flutter developer has opinions. Here's my pragmatic take after shipping three apps:

| Approach | Best for | My take |
|----------|----------|---------|
| `setState` | Local widget state | Fine for simple screens |
| Provider | App-wide state, small-medium apps | My default choice |
| Riverpod | Provider's sharper sibling | Use on new projects |
| BLoC | Large teams, strict patterns | Verbose but testable |

### Provider: The Sweet Spot

```dart
// pubspec.yaml
dependencies:
  provider: ^6.0.0

// Model
class UserModel extends ChangeNotifier {
  String _name = '';
  
  String get name => _name;
  
  void setName(String name) {
    _name = name;
    notifyListeners();  // Tells listening widgets to rebuild
  }
}

// Provider setup at app root
void main() {
  runApp(
    ChangeNotifierProvider(
      create: (context) => UserModel(),
      child: MyApp(),
    ),
  );
}

// Usage in any descendant widget
class UserScreen extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final user = Provider.of<UserModel>(context);
    
    return Scaffold(
      body: Text(user.name),
      floatingActionButton: FloatingActionButton(
        onPressed: () => user.setName('John Doe'),
        child: Icon(Icons.edit),
      ),
    );
  }
}
```

### Riverpod: Provider Evolved

If you're starting fresh, consider Riverpod—compile-time safety, no `BuildContext` required for reads:

```dart
dependencies:
  flutter_riverpod: ^2.0.0

final userProvider = StateNotifierProvider<UserNotifier, User>((ref) {
  return UserNotifier();
});

class UserNotifier extends StateNotifier<User> {
  UserNotifier() : super(User(name: ''));
  
  void setName(String name) {
    state = User(name: name);
  }
}

class UserScreen extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final user = ref.watch(userProvider);
    
    return Scaffold(
      body: Text(user.name),
      floatingActionButton: FloatingActionButton(
        onPressed: () => ref.read(userProvider.notifier).setName('John Doe'),
        child: Icon(Icons.edit),
      ),
    );
  }
}
```

Don't overthink this on day one. Start with Provider or Riverpod. Refactor to BLoC only if your team demands it or your state logic becomes genuinely unmanageable.

## Navigation: Getting Between Screens

### Imperative Navigation (Works Fine)

```dart
// Push a new screen
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (context) => DetailScreen(userId: '123'),
  ),
);

// Go back
Navigator.pop(context);

// Push and wait for result
final result = await Navigator.push(
  context,
  MaterialPageRoute(builder: (context) => EditScreen()),
);
```

### Named Routes (Better for Larger Apps)

```dart
class MyApp extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      initialRoute: '/',
      routes: {
        '/': (context) => HomeScreen(),
        '/details': (context) => DetailScreen(),
        '/profile': (context) => ProfileScreen(),
      },
    );
  }
}

// Navigate by name
Navigator.pushNamed(context, '/details');
```

For apps with 10+ screens, look at `go_router` (Flutter's recommended declarative routing). Named routes get messy with deep linking.

## API Integration: Where Production Apps Live or Die

### HTTP Service Layer

Keep API calls out of widgets. Always.

```dart
dependencies:
  http: ^1.0.0

import 'package:http/http.dart' as http;
import 'dart:convert';

class ApiService {
  final String baseUrl = 'https://api.example.com';
  
  Future<User> getUser(String userId) async {
    final response = await http.get(
      Uri.parse('$baseUrl/users/$userId'),
      headers: {'Authorization': 'Bearer $token'},
    );
    
    if (response.statusCode == 200) {
      return User.fromJson(json.decode(response.body));
    } else {
      throw Exception('Failed to load user');
    }
  }
  
  Future<List<User>> getUsers() async {
    final response = await http.get(Uri.parse('$baseUrl/users'));
    
    if (response.statusCode == 200) {
      final List<dynamic> data = json.decode(response.body);
      return data.map((json) => User.fromJson(json)).toList();
    } else {
      throw Exception('Failed to load users');
    }
  }
}
```

### Models with JSON Serialization

```dart
class User {
  final String id;
  final String name;
  final String email;
  
  User({
    required this.id,
    required this.name,
    required this.email,
  });
  
  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      id: json['id'],
      name: json['name'],
      email: json['email'],
    );
  }
  
  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'email': email,
    };
  }
}
```

For larger projects, use `json_serializable` or `freezed` code generation. Hand-writing `fromJson` for 30 models gets old fast.

**Production tip:** show loading states. Users will tap retry six times if you show a blank screen during a 3-second API call.

## Local Storage: Persistence Options

### Shared Preferences (Simple Key-Value)

```dart
dependencies:
  shared_preferences: ^2.0.0

class StorageService {
  static Future<void> saveString(String key, String value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(key, value);
  }
  
  static Future<String?> getString(String key) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(key);
  }
}
```

Good for: auth tokens, user preferences, onboarding flags.

For structured data or offline-first, use `hive` or `sqflite`. Shared Preferences isn't a database—don't store your entire user object as a JSON string and wonder why it's slow.

## Testing: The Part Everyone Skips (Don't)

### Unit Tests

```dart
test('User fromJson creates correct User object', () {
  final json = {
    'id': '123',
    'name': 'John Doe',
    'email': 'john@example.com',
  };
  
  final user = User.fromJson(json);
  
  expect(user.id, '123');
  expect(user.name, 'John Doe');
  expect(user.email, 'john@example.com');
});
```

### Widget Tests

```dart
testWidgets('Counter increments', (WidgetTester tester) async {
  await tester.pumpWidget(MyApp());
  
  expect(find.text('0'), findsOneWidget);
  
  await tester.tap(find.byIcon(Icons.add));
  await tester.pump();
  
  expect(find.text('1'), findsOneWidget);
});
```

Test your models and business logic thoroughly. Widget tests for critical user flows. Integration tests for the happy path before each release.

## Deployment: The Unsexy Finale

### Android

```bash
# APK for direct distribution
flutter build apk --release

# App Bundle for Play Store (required for new apps)
flutter build appbundle --release

# Signing — do this ONCE, back up the keystore
keytool -genkey -v -keystore ~/upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

Lose your Android signing keystore and you can never update your app. I've seen it happen. Use a password manager and backups.

### iOS

```bash
flutter build ios --release
open ios/Runner.xcworkspace
# Archive in Xcode → Upload to App Store Connect
```

iOS deployment is still more painful than Android. Budget time for provisioning profiles, certificates, and the occasional "Xcode says no" mystery.

## Lessons From Production

1. **Extract widgets early** — 400-line `build()` methods are a maintenance tax
2. **Use `ListView.builder`** for lists — never `ListView(children: items.map(...))` for 1000 items
3. **Handle platform differences explicitly** — `Platform.isIOS` exists for a reason
4. **Profile before optimizing** — Flutter DevTools is excellent; guessing is not
5. **Pin your dependencies** — `pubspec.lock` goes in version control
6. **Test on real devices** — simulators lie about performance and gestures

## Conclusion

Flutter didn't kill native iOS and Android development—and it doesn't need to. It killed the *unnecessary duplication* of business logic, UI patterns, and bug fixes across two codebases for apps that didn't need platform-specific magic.

One codebase. Real performance. Hot reload that saves hours weekly. A growing ecosystem of packages. Dart is fine—better than fine once you stop comparing it to Kotlin for a week.

Start with widgets and `setState`. Add Provider or Riverpod when state leaks across screens. Structure your project before you have 40 files in `lib/`. Test the API layer. Back up your signing keys.

The "write once, run everywhere" promise is still a lie if you mean *identical* on every platform. But "write once, ship everywhere with 90% shared code and platform-adaptive polish"? Flutter delivers that. We proved it in production.

---

*Building mobile apps with Flutter from February 2020, covering Flutter 1.12+ features.*
