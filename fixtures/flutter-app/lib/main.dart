import 'package:flutter/material.dart';

import 'counter_service.dart';

void main() {
  runApp(const FixtureApp());
}

class FixtureApp extends StatelessWidget {
  const FixtureApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fixture',
      home: Scaffold(
        appBar: AppBar(title: const Text('Fixture')),
        body: const CounterView(),
      ),
    );
  }
}

class CounterView extends StatefulWidget {
  const CounterView({super.key});

  @override
  State<CounterView> createState() => _CounterViewState();
}

class _CounterViewState extends State<CounterView> {
  final CounterService _service = CounterService();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('Count: ${_service.count}'),
          ElevatedButton(
            onPressed: () => setState(_service.increment),
            child: const Text('Increment'),
          ),
        ],
      ),
    );
  }
}
