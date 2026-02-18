---
layout: post
title: "Building Mobile Apps with Flutter: A Practical Guide"
date: 2020-02-11
categories: [How-To]
tags: [Flutter, Mobile, Dart]
excerpt: "Build cross-platform mobile apps with Flutter. Learn widgets, state management, navigation, API integration, and deployment for iOS and Android."
---

Flutter enables building native iOS and Android apps with one codebase. After shipping Flutter apps, here's a practical guide.

## Flutter Basics

### Installation

```bash
# Install Flutter SDK
git clone https://github.com/flutter/flutter.git
export PATH="$PATH:`pwd`/flutter/bin"

# Verify installation
flutter doctor

# Create new project
flutter create my_app
cd my_app
flutter run
```

### Project Structure

```
lib/
├── main.dart
├── models/
├── screens/
├── widgets/
├── services/
└── utils/
```

## Widgets

### Stateless Widget

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

### Stateful Widget

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

## State Management

### Provider

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
    notifyListeners();
  }
}

// Provider setup
void main() {
  runApp(
    ChangeNotifierProvider(
      create: (context) => UserModel(),
      child: MyApp(),
    ),
  );
}

// Usage
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

### Riverpod

```dart
// pubspec.yaml
dependencies:
  flutter_riverpod: ^2.0.0

// Provider
final userProvider = StateNotifierProvider<UserNotifier, User>((ref) {
  return UserNotifier();
});

class UserNotifier extends StateNotifier<User> {
  UserNotifier() : super(User(name: ''));
  
  void setName(String name) {
    state = User(name: name);
  }
}

// Usage
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

## Navigation

### Basic Navigation

```dart
// Navigate to new screen
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (context) => DetailScreen(),
  ),
);

// Navigate with arguments
Navigator.push(
  context,
  MaterialPageRoute(
    builder: (context) => DetailScreen(userId: '123'),
  ),
);

// Navigate back
Navigator.pop(context);

// Navigate with result
final result = await Navigator.push(
  context,
  MaterialPageRoute(builder: (context) => EditScreen()),
);
```

### Named Routes

```dart
// Define routes
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

// Navigate
Navigator.pushNamed(context, '/details');

// Navigate with arguments
Navigator.pushNamed(
  context,
  '/details',
  arguments: {'userId': '123'},
);
```

## API Integration

### HTTP Requests

```dart
// pubspec.yaml
dependencies:
  http: ^1.0.0

// Service
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

### Model

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

## Local Storage

### Shared Preferences

```dart
// pubspec.yaml
dependencies:
  shared_preferences: ^2.0.0

// Usage
import 'package:shared_preferences/shared_preferences.dart';

class StorageService {
  static Future<void> saveString(String key, String value) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(key, value);
  }
  
  static Future<String?> getString(String key) async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(key);
  }
  
  static Future<void> remove(String key) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(key);
  }
}
```

## Testing

### Unit Test

```dart
// test/user_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/models/user.dart';

void main() {
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
}
```

### Widget Test

```dart
// test/widget_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:my_app/main.dart';

void main() {
  testWidgets('Counter increments', (WidgetTester tester) async {
    await tester.pumpWidget(MyApp());
    
    expect(find.text('0'), findsOneWidget);
    
    await tester.tap(find.byIcon(Icons.add));
    await tester.pump();
    
    expect(find.text('1'), findsOneWidget);
  });
}
```

## Deployment

### Android

```bash
# Build APK
flutter build apk --release

# Build App Bundle (for Play Store)
flutter build appbundle --release

# Signing
keytool -genkey -v -keystore ~/upload-keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

### iOS

```bash
# Build for iOS
flutter build ios --release

# Archive in Xcode
open ios/Runner.xcworkspace
# Then Archive and upload to App Store
```

## Best Practices

1. **Use const constructors** - Performance optimization
2. **Extract widgets** - Reusable components
3. **State management** - Provider/Riverpod
4. **Error handling** - Try-catch blocks
5. **Loading states** - Show progress indicators
6. **Test coverage** - Unit and widget tests
7. **Code organization** - Clear structure
8. **Performance** - Use ListView.builder for lists

## Conclusion

Flutter enables:
- Single codebase for iOS and Android
- Native performance
- Rich UI components
- Fast development

Start with basic widgets, then add state management and API integration. The patterns shown here work for production apps.

---

*Building mobile apps with Flutter from February 2020, covering Flutter 1.12+ features.*
