import 'package:flutter_test/flutter_test.dart';

import 'package:fixture_flutter_app/counter_service.dart';

void main() {
  test('increment increases count', () {
    final service = CounterService();
    service.increment();
    expect(service.count, 1);
  });

  test('parseCount falls back to zero on garbage', () {
    expect(CounterService().parseCount('nope'), 0);
  });
}
