import {HttpException, HttpStatus, Injectable} from '@nestjs/common';
import { InjectRepository } from "@nestjs/typeorm";
import { Payment } from "./entities/payment.entity";
import { TypeOrmCrudService } from "@nestjsx/crud-typeorm";
import { Interval } from "@nestjs/schedule";
import { Transaction } from "../transaction/entities/transaction.entity";
import { TransactionService } from "../transaction/transaction.service";
import { MailerService } from "@nest-modules/mailer";
import {Repository} from "typeorm";
import {StoresService} from "../stores/stores.service";
import {HttpService} from "@nestjs/axios";

@Injectable()
export class PaymentService {
  constructor(@InjectRepository(Payment)
              private readonly repo: Repository<Payment>,
              private readonly transactionService: TransactionService,
              private readonly storesService: StoresService,
              private mailerService: MailerService,
              private httpService: HttpService
  ) {
  }

  async create(payment) {
    try {
      const store = await this.storesService.findStore(payment.apiKey)
      if (store) {
        const newPayment =  await this.repo.save({...payment, status: 'Not_paid', datetime: new Date(), store})
        return newPayment
      }
    } catch (err) {
      throw new HttpException(err, HttpStatus.BAD_REQUEST);
    }
  }

  async findByUser(userId) {
    const userPayments = this.repo.find({
      where: {
        user: userId
      }
    })
    return userPayments
  }

  async sendMail(payment, email) {
    console.log(payment.store.url)
    try {
      const successCallback = await this.httpService.post(payment.store.url, payment).toPromise();
      console.log(successCallback.data)
    } catch (e) {
      console.log('post callback Error', e)

    }



    await this.mailerService.sendMail({
      to:  email,
      from: process.env.MAILER_EMAIL,
      subject: 'Payment status changed',
      template: 'payment-status-changed',
      context: {
        login: email,
        email: email,
        status: payment.status,
      },
    });

  }

  @Interval(60000)
  async updateStatus() {
    console.log('status updated')
    await this.transactionService.updateTransactions()
    const payments = await this.repo.find({
      relations: ['store'],
    });
    console.log({payments})
    try {
      const updatedPayments = await Promise.all(payments.map(async (payment) => {
        const casperTransactions = await this.transactionService.find({
          where: {
            payment: payment,
            status: 'success'
          }
        });
        const fakeTransactions = await this.transactionService.find({
          where: {
            payment: payment,
            status: 'fake_success'
          }
        });

        const transactions = [...fakeTransactions, ...casperTransactions]

        const getTransactionsTotal = () => {
          let counter = 0
          transactions.forEach((transaction, i) => {
            counter += +transaction.amount
          })
          return counter
        }

        if (payment.status !== 'Paid') {
          if (getTransactionsTotal() >= +payment.amount) {
            const store = await this.storesService.findOne({
              where: {
                id: payment.store.id
              },
              relations: ['user'],
            });
            payment.status = 'Paid'
            await this.sendMail(payment, store.user.email)
            return payment
          }
          if (getTransactionsTotal() !== +payment.amount && getTransactionsTotal() > 0) {
            const store = await this.storesService.findOne({
              where: {
                id: payment.store.id
              },
              relations: ['user'],
            });
            payment.status = 'Particularly_paid'
            await this.sendMail(payment, store.user.email)
            return payment
          }
        }
        return payment
      }))
      console.log({updatedPayments})
      await this.repo.save(updatedPayments)
    } catch (e) {
      console.log('other error: ', e)
    }
  }
}
